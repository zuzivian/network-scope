import { drag } from 'd3-drag';
import {
  forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
  type Simulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from 'd3-force';
import { interpolateZoom } from 'd3-interpolate';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, zoomTransform, type ZoomBehavior } from 'd3-zoom';
import { isSocial, type Context, type LinkKind, type Network, type Node as Person } from './model';
import type { State } from './state';

type Kind = 'me' | 'world' | 'context' | 'person';

interface GNode extends SimulationNodeDatum {
  id: string;
  kind: Kind;
  label: string;
  r: number;
  person?: Person;
  ctx?: Context;
  worlds: string[];
  ax: number; // anchor
  ay: number;
}

interface GLink extends SimulationLinkDatum<GNode> {
  kind: LinkKind;
  source: GNode;
  target: GNode;
}

export interface GraphView {
  update(state: State): void;
  resetView(): void;
}

/** Fill strength by closeness: core people solid, acquaintances light. Not-yet-met people are hollow. */
const FILL: Record<number, number> = { 1: 1, 2: 0.8, 3: 0.45, 4: 0.3 };

function personRadius(p: Person) {
  return p.ring === 1 ? 7 : p.ring === 2 ? 5.75 : p.tier === 1 ? 5.5 : 4.5;
}

/** Order worlds around the circle so the most-bridged pairs sit next to each other. */
function orderWorlds(net: Network): Context[] {
  const ids = net.worlds.map((w) => w.id);
  const shared = new Map<string, number>();
  for (const p of net.people) {
    for (let i = 0; i < p.worlds.length; i++) for (let j = i + 1; j < p.worlds.length; j++) {
      const k = [p.worlds[i], p.worlds[j]].sort().join('|');
      shared.set(k, (shared.get(k) ?? 0) + 1);
    }
  }
  const w = (a: string, b: string) => shared.get([a, b].sort().join('|')) ?? 0;
  if (ids.length > 8) return net.worlds;
  let best = ids, bestScore = -1;
  const permute = (rest: string[], acc: string[]) => {
    if (!rest.length) {
      const score = acc.reduce((s, id, i) => s + w(id, acc[(i + 1) % acc.length]), 0);
      if (score > bestScore) { bestScore = score; best = acc; }
      return;
    }
    rest.forEach((id, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, id]));
  };
  permute(ids.slice(1), [ids[0]]); // fix the first to drop rotations
  return best.map((id) => net.worlds.find((x) => x.id === id)!);
}

export function mountGraph(host: HTMLElement, net: Network, onSelect: (id: string | null) => void): GraphView {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const svg = select(host).append('svg').attr('class', 'graph').attr('role', 'img')
    .attr('aria-label', `Network graph: ${net.people.length} people in ${net.contexts.length} contexts`);
  // A dot grid behind the network moves at a slower rate than it (parallax), so panning and
  // flying between nodes reads as travelling over a surface rather than sliding a flat picture.
  const defs = svg.append('defs');
  const grid = defs.append('pattern').attr('id', 'ground').attr('patternUnits', 'userSpaceOnUse').attr('width', 28).attr('height', 28);
  grid.append('circle').attr('cx', 1).attr('cy', 1).attr('r', 0.9).attr('class', 'ground-dot');
  const ground = svg.append('rect').attr('class', 'ground').attr('fill', 'url(#ground)');
  const view = svg.append('g').attr('class', 'view');
  const linkLayer = view.append('g').attr('class', 'links');
  const trailLayer = view.append('g').attr('class', 'trail-layer');
  const trailPath = trailLayer.append('path').attr('class', 'trail-path');
  let trail: string[] = [];
  const pulseLayer = view.append('g').attr('class', 'pulses');
  const nodeLayer = view.append('g').attr('class', 'nodes');
  const trailNav = select(host).append('nav').attr('class', 'trail').attr('aria-label', 'Your path through the network');

  // ----- Build nodes and anchors -----
  const worlds = orderWorlds(net);
  const worldSize = new Map(worlds.map((w) => [w.id, net.people.filter((p) => p.world === w.id).length]));
  const total = [...worldSize.values()].reduce((a, b) => a + Math.sqrt(b + 4), 0);
  const anchor = new Map<string, { x: number; y: number }>();
  let cursor = -Math.PI / 2;
  const RW = 300;
  for (const w of worlds) {
    const span = (Math.sqrt((worldSize.get(w.id) ?? 0) + 4) / total) * Math.PI * 2;
    const a = cursor + span / 2;
    cursor += span;
    const dist = RW * (0.75 + 0.35 * Math.min(1, (worldSize.get(w.id) ?? 0) / 40));
    anchor.set(w.id, { x: Math.cos(a) * dist, y: Math.sin(a) * dist });
  }
  const avg = (ids: string[]) => {
    const pts = ids.map((id) => anchor.get(id)!).filter(Boolean);
    return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  };

  const nodes: GNode[] = [];
  nodes.push({ id: net.me.id, kind: 'me', label: initials(net.me.name === 'Me' ? 'You' : net.me.name), r: 17, worlds: [], ax: 0, ay: 0, fx: 0, fy: 0 });
  for (const c of net.contexts) {
    const a = anchor.get(c.world) ?? { x: 0, y: 0 };
    const isWorld = c.depth === 1;
    nodes.push({
      id: c.id, kind: isWorld ? 'world' : 'context', label: c.name, r: isWorld ? 12 : 6.5, ctx: c, worlds: [c.world],
      ax: a.x, ay: a.y, x: a.x * (isWorld ? 1 : 1.15), y: a.y * (isWorld ? 1 : 1.15),
    });
  }
  for (const p of net.people) {
    const a = avg(p.worlds);
    nodes.push({
      id: p.id, kind: 'person', label: p.name, r: personRadius(p), person: p, worlds: p.worlds,
      ax: a.x * 1.25, ay: a.y * 1.25, x: a.x * 1.3 + (Math.random() - 0.5) * 40, y: a.y * 1.3 + (Math.random() - 0.5) * 40,
    });
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links: GLink[] = net.links
    .filter((l) => byId.has(l.a) && byId.has(l.b))
    .map((l) => ({ kind: l.kind, source: byId.get(l.a)!, target: byId.get(l.b)! }));

  const neighbours = new Map<string, Set<string>>();
  for (const l of links) {
    const a = l.source.id, b = l.target.id;
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    if (!neighbours.has(b)) neighbours.set(b, new Set());
    neighbours.get(a)!.add(b);
    neighbours.get(b)!.add(a);
  }

  // ----- Forces -----
  const charge: Record<Kind, number> = { me: -1000, world: -650, context: -300, person: -75 };
  const sim: Simulation<GNode, GLink> = forceSimulation(nodes)
    .force('link', forceLink<GNode, GLink>(links).id((d) => d.id)
      .distance((l) => (l.kind === 'part' ? (l.source.kind === 'me' ? RW * 0.8 : 85) : l.kind === 'member' ? 44 : 60))
      .strength((l) => (l.kind === 'part' ? 0.6 : l.kind === 'member' ? 0.5 / Math.max(1, (l.target.person?.contexts.length ?? 1)) : 0.15)))
    .force('charge', forceManyBody<GNode>().strength((d) => charge[d.kind]).distanceMax(600))
    .force('x', forceX<GNode>((d) => d.ax).strength((d) => (d.kind === 'world' ? 0.35 : 0.04)))
    .force('y', forceY<GNode>((d) => d.ay).strength((d) => (d.kind === 'world' ? 0.35 : 0.04)))
    .force('collide', forceCollide<GNode>((d) => d.r + (d.kind === 'person' ? 3 : 8)).iterations(2))
    .stop();
  sim.tick(400);
  const labels = placeLabels(nodes);

  // ----- Render -----
  const linkSel = linkLayer.selectAll<SVGLineElement, GLink>('line').data(links).join('line')
    .attr('class', (l) => `link ${l.kind}${isSocial({ a: '', b: '', kind: l.kind }) ? ' social' : ''}`);

  const nodeSel = nodeLayer.selectAll<SVGGElement, GNode>('g').data(nodes, (d) => d.id).join('g')
    .attr('class', (d) => `${nodeClass(d)}${labels.has(d.id) ? ' labelled' : ''}`)
    .attr('data-id', (d) => d.id)
    .attr('tabindex', (d) => (d.kind === 'me' ? -1 : 0))
    .attr('role', 'button')
    .attr('aria-label', (d) => (d.person ? `${d.label}${d.person.org ? `, ${d.person.org}` : ''}` : d.label))
    .on('click', (e: MouseEvent, d) => { e.stopPropagation(); if (d.kind !== 'me') onSelect(d.id); })
    .on('keydown', (e: KeyboardEvent, d) => { if ((e.key === 'Enter' || e.key === ' ') && d.kind !== 'me') { e.preventDefault(); onSelect(d.id); } })
    .on('mouseenter', (_, d) => hover(d.id))
    .on('mouseleave', () => hover(null));

  nodeSel.append('circle').attr('class', 'hit').attr('r', (d) => d.r + 6);
  // Your closest people breathe: a slow glow, stronger for core than active.
  nodeSel.filter((d) => !!d.person?.met && d.person.ring <= 2).append('circle').attr('class', 'glow').attr('r', (d) => d.r + 5)
    .style('--warm', (d) => (d.person!.ring === 1 ? '1' : '0.6')).style('animation-delay', () => `${(-Math.random() * 4).toFixed(2)}s`);
  nodeSel.filter((d) => d.kind === 'context').append('rect').attr('class', 'shape')
    .attr('x', (d) => -d.r).attr('y', (d) => -d.r).attr('width', (d) => d.r * 2).attr('height', (d) => d.r * 2)
    .attr('transform', 'rotate(45)');
  nodeSel.filter((d) => d.kind !== 'context').append('circle').attr('class', 'shape').attr('r', (d) => d.r)
    .style('fill-opacity', (d) => {
      const p = d.person;
      if (!p) return null;
      if (!p.met) return 0;
      return FILL[p.ring];
    });
  nodeSel.filter((d) => d.kind === 'me').append('text').attr('class', 'me-text').attr('dy', '0.35em').text((d) => d.label);
  nodeSel.filter((d) => d.kind !== 'me').append('text').attr('class', 'label')
    .attr('dy', (d) => (d.kind === 'person' ? '0.35em' : d.r + 13))
    .attr('x', (d) => (d.kind !== 'person' ? 0 : labels.get(d.id) === 'left' ? -(d.r + 4) : d.r + 4))
    .attr('text-anchor', (d) => (d.kind !== 'person' ? 'middle' : labels.get(d.id) === 'left' ? 'end' : 'start'))
    .text((d) => (d.kind === 'world' ? d.label.toUpperCase() : d.label));

  const dragger = drag<SVGGElement, GNode>()
    .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.25).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
    .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); if (d.kind !== 'me') { d.fx = null; d.fy = null; } });
  nodeSel.filter((d) => d.kind !== 'me').call(dragger);

  function paint() {
    linkSel.attr('x1', (l) => l.source.x!).attr('y1', (l) => l.source.y!).attr('x2', (l) => l.target.x!).attr('y2', (l) => l.target.y!);
    nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
    paintTrail();
  }
  sim.on('tick', paint);
  paint();

  // ----- Zoom -----
  const zoomer: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.3, 5])
    .on('zoom', (e) => {
      const t = e.transform;
      view.attr('transform', t.toString());
      svg.classed('zoomed', t.k > 1.35);
      grid.attr('patternTransform', `translate(${t.x * 0.45},${t.y * 0.45}) scale(${Math.sqrt(t.k)})`);
    });
  svg.call(zoomer).on('dblclick.zoom', null);
  svg.on('click', (e: MouseEvent) => { if (e.target === svg.node()) onSelect(null); });

  function fit() {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    svg.attr('viewBox', `${-width / 2} ${-height / 2} ${width} ${height}`);
    ground.attr('x', -width / 2).attr('y', -height / 2).attr('width', width).attr('height', height);
    const xs = nodes.map((n) => n.x!), ys = nodes.map((n) => n.y!);
    const w = Math.max(...xs) - Math.min(...xs) + 120, h = Math.max(...ys) - Math.min(...ys) + 60;
    const k = Math.min(1.4, Math.min(width / w, height / h));
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    svg.call(zoomer.transform, zoomIdentity.scale(k).translate(-cx, -cy));
  }
  // Later resizes (a scrollbar appearing, the window changing) keep the camera where it is.
  let fitted = false;
  new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    if (!fitted) { fitted = true; return fit(); }
    svg.attr('viewBox', `${-width / 2} ${-height / 2} ${width} ${height}`);
    ground.attr('x', -width / 2).attr('y', -height / 2).attr('width', width).attr('height', height);
  }).observe(host);
  fit();
  if (host.getBoundingClientRect().width) fitted = true;

  // ----- Camera: fly to whatever you select (zooms out a little, travels, zooms back in) -----
  let flight = 0;
  function flyTo(ids: Set<string>, anchorId: string) {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    const pts = [...ids].map((id) => byId.get(id)).filter((n): n is GNode => !!n && n.kind !== 'me');
    const a = byId.get(anchorId)!;
    // Frame the node and its neighbourhood, but never so wide that the node itself gets lost.
    const near = pts.filter((n) => Math.hypot(n.x! - a.x!, n.y! - a.y!) < 420);
    const xs = near.map((n) => n.x!), ys = near.map((n) => n.y!);
    const span = Math.max(160, Math.max(...xs) - Math.min(...xs) + 140, (Math.max(...ys) - Math.min(...ys) + 100) * (width / height));
    const k = Math.max(0.7, Math.min(2.6, width / span));
    const t0 = zoomTransform(svg.node()!);
    const from: [number, number, number] = [-t0.x / t0.k, -t0.y / t0.k, width / t0.k];
    const to: [number, number, number] = [a.x!, a.y!, width / k];
    const go = (v: [number, number, number]) => { const kk = width / v[2]; svg.call(zoomer.transform, zoomIdentity.translate(-v[0] * kk, -v[1] * kk).scale(kk)); };
    cancelAnimationFrame(flight);
    if (reduceMotion || document.hidden) return go(to);
    const lerp = interpolateZoom(from, to);
    const ms = Math.min(1400, Math.max(450, lerp.duration * 0.7));
    const start = performance.now();
    const step = (now: number) => {
      const u = Math.min(1, (now - start) / ms);
      go(lerp(u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2));
      if (u < 1) flight = requestAnimationFrame(step);
    };
    flight = requestAnimationFrame(step);
  }
  // Interrupt a flight as soon as you grab the map.
  svg.on('pointerdown.flight wheel.flight', () => cancelAnimationFrame(flight));

  // ----- Signal pulses: dots travel outward along the focused node's links -----
  let pulseFrame = 0;
  let pulseLinks: { from: GNode; to: GNode; offset: number }[] = [];
  function startPulses(id: string | null) {
    cancelAnimationFrame(pulseFrame);
    pulseLayer.selectAll('*').remove();
    if (!id || reduceMotion) return;
    const n = byId.get(id)!;
    pulseLinks = links.filter((l) => l.source.id === id || l.target.id === id)
      .map((l) => ({ from: n, to: l.source.id === id ? l.target : l.source, offset: Math.random() }))
      .sort((a, b) => (a.to.kind === 'person' ? 1 : 0) - (b.to.kind === 'person' ? 1 : 0))
      .slice(0, 48);
    const dots = pulseLayer.selectAll<SVGCircleElement, unknown>('circle').data(pulseLinks).join('circle').attr('class', 'pulse').attr('r', 2.4);
    const t0 = performance.now();
    const tick = (now: number) => {
      dots.each(function (p) {
        const f = ((now - t0) / 1600 + p.offset) % 1;
        const e = 1 - (1 - f) ** 2;
        this.setAttribute('cx', String(p.from.x! + (p.to.x! - p.from.x!) * e));
        this.setAttribute('cy', String(p.from.y! + (p.to.y! - p.from.y!) * e));
        this.style.opacity = String(Math.sin(Math.PI * f));
      });
      pulseFrame = requestAnimationFrame(tick);
    };
    pulseFrame = requestAnimationFrame(tick);
  }

  // ----- Trail: where you've been, drawn on the map and listed as breadcrumbs -----
  function paintTrail() {
    const pts = trail.map((id) => byId.get(id)).filter((n): n is GNode => !!n);
    trailPath.attr('d', pts.length > 1 ? `M${pts.map((n) => `${n.x},${n.y}`).join('L')}` : null);
  }
  function renderTrail() {
    paintTrail();
    trailNav.classed('on', trail.length > 0).html(trail.length ? `<span class="trail-label">Path</span>${trail.map((id, i) => {
      const n = byId.get(id)!;
      return `${i ? '<span class="trail-sep">›</span>' : ''}<button data-trail="${id}" ${i === trail.length - 1 ? 'aria-current="true"' : ''}>${escapeHtml(n.label)}</button>`;
    }).join('')}<button class="trail-clear" data-trail-clear title="Clear path">×</button>` : '');
  }
  trailNav.on('click', (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.trailClear !== undefined) { trail = []; renderTrail(); return onSelect(null); }
    if (b.dataset.trail) onSelect(b.dataset.trail);
  });

  // ----- Keyboard traversal: ← → step through the selected node's connections, Enter goes there -----
  let candidates: string[] = [];
  let step = -1;
  function setCandidates(id: string | null) {
    const n = id ? byId.get(id) : null;
    candidates = n ? [...(neighbours.get(n.id) ?? [])].map((x) => byId.get(x)!).filter((x) => x.kind !== 'me')
      .sort((a, b) => Math.atan2(a.y! - n.y!, a.x! - n.x!) - Math.atan2(b.y! - n.y!, b.x! - n.x!)).map((x) => x.id) : [];
    step = -1;
    nodeSel.classed('candidate', false);
  }
  document.addEventListener('keydown', (e) => {
    if (host.hidden || !state?.selected || (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]'))) return;
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && candidates.length) {
      e.preventDefault();
      step = (step + (e.key === 'ArrowRight' ? 1 : -1) + candidates.length) % candidates.length;
      const id = candidates[step];
      nodeSel.classed('candidate', (d) => d.id === id);
      hover(id);
    } else if (e.key === 'Enter' && step >= 0) {
      e.preventDefault();
      const id = candidates[step];
      hovered = null;
      onSelect(id);
    } else if (e.key === 'Backspace' && trail.length > 1) {
      e.preventDefault();
      onSelect(trail[trail.length - 2]);
    }
  });

  // ----- State -----
  let state: State | null = null;
  let hovered: string | null = null;
  let lastSelected: string | null = null;

  function hover(id: string | null) {
    hovered = id;
    if (state) update(state);
  }

  function focusSet(id: string | null): Set<string> | null {
    if (!id) return null;
    const set = new Set([id, ...(neighbours.get(id) ?? [])]);
    // A context's focus includes its sub-contexts' members too.
    const n = byId.get(id);
    if (n?.ctx) {
      const sub = net.contexts.filter((c) => isDescendant(c, id));
      for (const c of sub) { set.add(c.id); neighbours.get(c.id)?.forEach((x) => set.add(x)); }
    }
    return set;
  }

  function isDescendant(c: Context, ancestor: string): boolean {
    for (let cur: Context | undefined = c; cur; cur = net.contexts.find((x) => x.id === cur!.parent)) {
      if (cur.parent === ancestor) return true;
    }
    return false;
  }

  function update(s: State) {
    state = s;
    if (s.selected !== lastSelected) {
      lastSelected = s.selected;
      if (s.selected) {
        // Going back to a node already on the path rewinds the path to it.
        const at = trail.indexOf(s.selected);
        trail = at >= 0 ? trail.slice(0, at + 1) : [...trail, s.selected].slice(-7);
        if (!host.hidden) flyTo(focusSet(s.selected)!, s.selected);
      }
      hovered = null;
      setCandidates(s.selected);
      startPulses(s.selected);
      renderTrail();
    }
    const focus = focusSet(hovered ?? s.selected);
    const q = s.query.trim().toLowerCase();
    nodeSel.each(function (d) {
      const g = select(this);
      const p = d.person;
      const hidden = d.kind !== 'me' && d.worlds.every((w) => s.hidden.has(w));
      const matches = !q || (`${d.label} ${p?.org ?? ''} ${p?.role ?? ''}`.toLowerCase().includes(q));
      const outOfFocus = !!focus && !focus.has(d.id) && d.kind !== 'me';
      g.classed('dim', hidden || (d.kind === 'person' && !matches) || outOfFocus)
        .classed('match', !!q && matches && d.kind === 'person' && !hidden)
        .classed('focus', !!focus && focus.has(d.id))
        .classed('selected', d.id === s.selected);
    });
    linkSel.classed('on', (l) => !!focus && focus.has(l.source.id) && focus.has(l.target.id) && (l.source.id === (hovered ?? s.selected) || l.target.id === (hovered ?? s.selected) || l.kind !== 'member'))
      .classed('dim', (l) => {
        const hide = (n: GNode) => n.kind !== 'me' && n.worlds.every((w) => s.hidden.has(w));
        return hide(l.source) || hide(l.target) || (!!focus && !(focus.has(l.source.id) && focus.has(l.target.id)));
      });
    svg.classed('has-focus', !!focus);
  }

  return {
    update,
    resetView: fit,
  };
}

type Box = { x0: number; y0: number; x1: number; y1: number };
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/**
 * Context labels are always on, so they are obstacles. People then claim label space
 * greedily (closest, flagged and bridges first), trying right then left.
 * Anyone who doesn't fit gets a label on hover, focus or zoom.
 */
function placeLabels(nodes: GNode[]): Map<string, 'left' | 'right'> {
  const taken: Box[] = nodes.map((n) => ({ x0: n.x! - n.r - 1, y0: n.y! - n.r - 1, x1: n.x! + n.r + 1, y1: n.y! + n.r + 1 }));
  for (const n of nodes) {
    if (n.kind !== 'world' && n.kind !== 'context') continue;
    const w = n.label.length * (n.kind === 'world' ? 7.6 : 5.6);
    const y = n.y! + n.r + 13;
    taken.push({ x0: n.x! - w / 2, y0: y - 9, x1: n.x! + w / 2, y1: y + 4 });
  }
  const out = new Map<string, 'left' | 'right'>();
  const want = nodes.filter((n) => n.person && (n.person.ring <= 2 || n.person.worlds.length > 1 || n.person.tier === 1));
  const rank = (n: GNode) => n.person!.ring - (n.person!.worlds.length > 1 ? 1 : 0);
  want.sort((a, b) => rank(a) - rank(b));
  for (const n of want) {
    const w = n.label.length * 5.9;
    const self = { x0: n.x! - n.r - 1, y0: n.y! - n.r - 1, x1: n.x! + n.r + 1, y1: n.y! + n.r + 1 };
    for (const side of ['right', 'left'] as const) {
      const x0 = side === 'right' ? n.x! + n.r + 4 : n.x! - n.r - 4 - w;
      const box = { x0, y0: n.y! - 7, x1: x0 + w, y1: n.y! + 7 };
      if (taken.some((t) => t !== self && overlaps(box, t) && !(t.x0 === self.x0 && t.y0 === self.y0))) continue;
      taken.push(box);
      out.set(n.id, side);
      break;
    }
  }
  return out;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function initials(name: string) {
  return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function nodeClass(d: GNode) {
  const p = d.person;
  const c = ['node', d.kind];
  if (p) {
    c.push(`ring-${p.ring}`);
    if (!p.met) c.push('unmet');
    if (p.worlds.length > 1) c.push('bridge');
  }
  return c.join(' ');
}
