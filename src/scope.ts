import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import { layout, RING_EDGES, toXY, type Placed, type Sector } from './layout';
import { isSocial, RINGS, type Network } from './model';
import type { State } from './state';

const SVGNS = 'http://www.w3.org/2000/svg';
const SWEEP_MS = 7000;
const TRAIL = 48; // degrees of afterglow behind the sweep line

export interface Scope {
  update(state: State): void;
  setMotion(on: boolean): void;
  resetView(): void;
}

function arcPath(r0: number, r1: number, a0: number, a1: number): string {
  const p = (b: number, r: number) => toXY(b, r);
  const large = a1 - a0 > 180 ? 1 : 0;
  const o0 = p(a0, r1), o1 = p(a1, r1), i1 = p(a1, r0), i0 = p(a0, r0);
  return `M${o0.x},${o0.y} A${r1},${r1} 0 ${large} 1 ${o1.x},${o1.y} L${i1.x},${i1.y} A${r0},${r0} 0 ${large} 0 ${i0.x},${i0.y} Z`;
}

export function mountScope(host: HTMLElement, net: Network, onSelect: (id: string | null) => void): Scope {
  const svg = select(host).append('svg').attr('class', 'scope').attr('role', 'img');
  svg.attr('aria-label', `Network scope: ${net.people.length} people across ${net.worlds.length} worlds`);
  const view = svg.append('g').attr('class', 'view');

  let placed: Placed[] = [];
  let sectors: Sector[] = [];
  let R = 300;
  let state: State | null = null;
  let motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  let raf = 0;
  const halos = new Map<string, SVGCircleElement>();

  const zoomer: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.6, 5])
    .on('zoom', (e) => {
      view.attr('transform', e.transform.toString());
      svg.classed('zoomed', e.transform.k > 1.5);
    });
  svg.call(zoomer).on('dblclick.zoom', null);
  svg.on('click', (e: MouseEvent) => {
    if (e.target === svg.node()) onSelect(null);
  });

  function draw() {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    const margin = width < 520 ? 34 : 58;
    R = Math.max(120, Math.min(width, height) / 2 - margin);
    svg.attr('viewBox', `${-width / 2} ${-height / 2} ${width} ${height}`);
    ({ placed, sectors } = layout(net, R));
    view.selectAll('*').remove();
    halos.clear();

    // Sector bands and dividers
    const grid = view.append('g').attr('class', 'grid');
    sectors.forEach((s, i) => {
      grid.append('path').attr('class', `band ${i % 2 ? 'alt' : ''}`).attr('d', arcPath(RING_EDGES[0] * R, R, s.start, s.end));
      [s.start, s.end].forEach((b) => {
        const a = toXY(b, RING_EDGES[0] * R), z = toXY(b, R);
        grid.append('line').attr('class', 'divider').attr('x1', a.x).attr('y1', a.y).attr('x2', z.x).attr('y2', z.y);
      });
    });
    RING_EDGES.forEach((f, i) => {
      grid.append('circle').attr('class', i === RING_EDGES.length - 1 ? 'ring outer' : 'ring').attr('r', f * R);
    });

    // Ring labels sit in the gap just west of north.
    const gapBearing = (sectors[0].start - 3 + 360) % 360;
    RINGS.forEach(({ ring, label }) => {
      const r = ((RING_EDGES[ring - 1] + RING_EDGES[ring]) / 2) * R;
      const { x, y } = toXY(gapBearing, r);
      grid.append('text').attr('class', 'ring-label').attr('x', x).attr('y', y)
        .attr('transform', `rotate(${gapBearing} ${x} ${y})`).text(label.toUpperCase());
    });

    // Bearing ticks
    const ticks = view.append('g').attr('class', 'ticks');
    for (let b = 0; b < 360; b += 5) {
      const long = b % 30 === 0;
      const a = toXY(b, R), z = toXY(b, R + (long ? 9 : 4));
      ticks.append('line').attr('class', long ? 'tick long' : 'tick').attr('x1', a.x).attr('y1', a.y).attr('x2', z.x).attr('y2', z.y);
      if (long && width >= 520) {
        const t = toXY(b, R + 20);
        ticks.append('text').attr('class', 'bearing').attr('x', t.x).attr('y', t.y).text(String(b).padStart(3, '0'));
      }
    }

    // Sector labels just inside the outer ring
    const labels = view.append('g').attr('class', 'sector-labels');
    sectors.forEach((s) => {
      const mid = (s.start + s.end) / 2;
      const { x, y } = toXY(mid, R - 14);
      const flip = ((mid % 360) + 360) % 360 > 90 && ((mid % 360) + 360) % 360 < 270;
      labels.append('text').attr('class', 'sector-label').attr('data-circle', s.circle.id)
        .attr('x', x).attr('y', y).attr('transform', `rotate(${flip ? mid + 180 : mid} ${x} ${y})`)
        .text(`${s.circle.name.toUpperCase()} · ${s.count}`);
    });

    // Afterglow sweep: stacked thin wedges approximate a conic fade.
    const sweep = view.append('g').attr('class', 'sweep');
    const steps = 16;
    for (let i = 0; i < steps; i++) {
      const a1 = -(i * TRAIL) / steps, a0 = -((i + 1) * TRAIL) / steps;
      sweep.append('path').attr('d', arcPath(0.01, R, a0, a1)).style('opacity', (1 - i / steps) * 0.22);
    }
    sweep.append('line').attr('class', 'sweep-line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', -R);
    sweep.style('display', motion ? '' : 'none');

    // Edges (warm paths). Curves bow toward the centre so they read as "through you".
    const pos = new Map(placed.map((p) => [p.node.id, p]));
    const social = net.links.filter((l) => isSocial(l) && pos.has(l.a) && pos.has(l.b));
    view.append('g').attr('class', 'edges').selectAll('path').data(social).join('path')
      .attr('class', (e) => `edge ${e.kind}`)
      .attr('data-a', (e) => e.a).attr('data-b', (e) => e.b)
      .attr('d', (e) => {
        const a = pos.get(e.a)!, b = pos.get(e.b)!;
        const cx = (a.x + b.x) * 0.3, cy = (a.y + b.y) * 0.3;
        return `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`;
      });

    view.append('g').attr('class', 'spoke');

    // Me
    const me = view.append('g').attr('class', 'me');
    me.append('circle').attr('r', RING_EDGES[0] * R * 0.55);
    me.append('text').attr('dy', '0.35em').text(net.me.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase());

    // Blips
    const blips = view.append('g').attr('class', 'blips').selectAll<SVGGElement, Placed>('g').data(placed).join('g')
      .attr('class', (d) => `blip ring-${d.node.ring}${d.node.met ? '' : ' never'}${d.showLabel ? ' labelled' : ''}`)
      .attr('data-id', (d) => d.node.id)
      .attr('transform', (d) => `translate(${d.x},${d.y})`)
      .attr('tabindex', 0)
      .attr('role', 'button')
      .attr('aria-label', (d) => `${d.node.name}, ${d.node.org ?? d.node.world}`)
      .on('click', (e: MouseEvent, d) => { e.stopPropagation(); onSelect(d.node.id); })
      .on('keydown', (e: KeyboardEvent, d) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(d.node.id); } });

    blips.append('circle').attr('class', 'hit').attr('r', (d) => d.size + 8);
    blips.each(function (d) {
      const h = document.createElementNS(SVGNS, 'circle');
      h.setAttribute('class', 'halo');
      h.setAttribute('r', String(d.size + 6));
      this.appendChild(h);
      halos.set(d.node.id, h);
    });
    blips.append('circle').attr('class', 'core').attr('r', (d) => d.size)
      .style('fill-opacity', (d) => (!d.node.met ? 0 : ({ 1: 1, 2: 0.8, 3: 0.45, 4: 0.3 } as Record<number, number>)[d.node.ring]));
    blips.append('text').attr('class', 'label')
      .attr('x', (d) => (d.labelLeft ? -(d.size + 5) : d.size + 5))
      .attr('dy', '0.35em')
      .attr('text-anchor', (d) => (d.labelLeft ? 'end' : 'start'))
      .text((d) => d.node.name);

    if (state) update(state);
  }

  function update(s: State) {
    state = s;
    const sel = s.selected;
    const linked = new Set<string>();
    if (sel) for (const e of net.links) { if (!isSocial(e)) continue; if (e.a === sel) linked.add(e.b); if (e.b === sel) linked.add(e.a); }
    const q = s.query.trim().toLowerCase();

    view.selectAll<SVGGElement, Placed>('.blip').each(function (d) {
      const n = d.node;
      const hidden = n.worlds.every((w) => s.hidden.has(w));
      const matches = !q || `${n.name} ${n.org ?? ''} ${n.role ?? ''}`.toLowerCase().includes(q);
      const g = select(this);
      g.classed('selected', n.id === sel)
        .classed('linked', linked.has(n.id))
        .classed('dim', hidden || !matches || (!!sel && n.id !== sel && !linked.has(n.id)))
        .classed('match', !!q && matches && !hidden);
    });
    view.selectAll<SVGTextElement, Sector>('.sector-label').classed('dim', function () {
      return s.hidden.has((this as SVGTextElement).dataset.circle as never);
    });
    view.selectAll<SVGPathElement, unknown>('.edges .edge').classed('on', function () {
      const el = this as SVGPathElement;
      return !!sel && (el.dataset.a === sel || el.dataset.b === sel);
    });
    svg.classed('has-selection', !!sel);

    // Range/bearing readout from you to the selected contact.
    const spoke = view.select<SVGGElement>('.spoke');
    spoke.selectAll('*').remove();
    const p = placed.find((x) => x.node.id === sel);
    if (p) {
      const start = toXY(p.bearing, RING_EDGES[0] * R * 0.55);
      spoke.append('line').attr('x1', start.x).attr('y1', start.y).attr('x2', p.x).attr('y2', p.y);
      const mid = { x: (start.x + p.x) / 2, y: (start.y + p.y) / 2 };
      spoke.append('text').attr('x', mid.x).attr('y', mid.y - 6).attr('text-anchor', 'middle')
        .text(`BRG ${String(Math.round(p.bearing)).padStart(3, '0')} · ${RINGS[p.node.ring - 1].label.toUpperCase()}${p.node.met ? '' : ' · NOT MET'}`);
    }
  }

  function tick(t: number) {
    const angle = ((t % SWEEP_MS) / SWEEP_MS) * 360;
    view.select('.sweep').attr('transform', `rotate(${angle})`);
    for (const p of placed) {
      const h = halos.get(p.node.id);
      if (!h) continue;
      const delta = (angle - p.bearing + 360) % 360;
      h.style.opacity = delta < TRAIL ? String((1 - delta / TRAIL) * (p.node.ring <= 2 ? 0.8 : 0.4)) : '0';
    }
    raf = requestAnimationFrame(tick);
  }

  function setMotion(on: boolean) {
    motion = on;
    cancelAnimationFrame(raf);
    view.select('.sweep').style('display', on ? '' : 'none');
    if (on) raf = requestAnimationFrame(tick);
    else halos.forEach((h) => (h.style.opacity = '0'));
  }

  new ResizeObserver(() => draw()).observe(host);
  draw();
  setMotion(motion);

  return {
    update,
    setMotion,
    resetView: () => { svg.call(zoomer.transform, zoomIdentity); },
  };
}
