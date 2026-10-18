import { drag } from 'd3-drag';
import {
  forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
  type Simulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from 'd3-force';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
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
  const svg = select(host).append('svg').attr('class', 'graph').attr('role', 'img')
    .attr('aria-label', `Network graph: ${net.people.length} people in ${net.contexts.length} contexts`);
  const view = svg.append('g').attr('class', 'view');
  const linkLayer = view.append('g').attr('class', 'links');
  const nodeLayer = view.append('g').attr('class', 'nodes');

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
  nodes.push({ id: net.me.id, kind: 'me', label: initials(net.me.name), r: 17, worlds: [], ax: 0, ay: 0, fx: 0, fy: 0 });
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
  nodeSel.filter((d) => !!d.person?.flags.length).append('circle').attr('class', 'alert').attr('r', (d) => d.r + 3.5);
  nodeSel.filter((d) => d.kind === 'context').append('rect').attr('class', 'shape')
    .attr('x', (d) => -d.r).attr('y', (d) => -d.r).attr('width', (d) => d.r * 2).attr('height', (d) => d.r * 2)
    .attr('transform', 'rotate(45)');
  nodeSel.filter((d) => d.kind !== 'context').append('circle').attr('class', 'shape').attr('r', (d) => d.r)
    .style('fill-opacity', (d) => {
      const p = d.person;
      if (!p) return null;
      if (!p.met) return 0;
      return p.warmth == null ? 0.5 : 0.22 + 0.78 * p.warmth;
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
  }
  sim.on('tick', paint);
  paint();

  // ----- Zoom -----
  const zoomer: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.3, 5])
    .on('zoom', (e) => {
      view.attr('transform', e.transform.toString());
      svg.classed('zoomed', e.transform.k > 1.35);
    });
  svg.call(zoomer).on('dblclick.zoom', null);
  svg.on('click', (e: MouseEvent) => { if (e.target === svg.node()) onSelect(null); });

  function fit() {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    svg.attr('viewBox', `${-width / 2} ${-height / 2} ${width} ${height}`);
    const xs = nodes.map((n) => n.x!), ys = nodes.map((n) => n.y!);
    const w = Math.max(...xs) - Math.min(...xs) + 120, h = Math.max(...ys) - Math.min(...ys) + 60;
    const k = Math.min(1.4, Math.min(width / w, height / h));
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    svg.call(zoomer.transform, zoomIdentity.scale(k).translate(-cx, -cy));
  }
  new ResizeObserver(() => fit()).observe(host);
  fit();

  // ----- State -----
  let state: State | null = null;
  let hovered: string | null = null;

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
    const focus = focusSet(hovered ?? s.selected);
    const q = s.query.trim().toLowerCase();
    nodeSel.each(function (d) {
      const g = select(this);
      const p = d.person;
      const hidden = d.kind !== 'me' && d.worlds.every((w) => s.hidden.has(w));
      const matches = !q || (`${d.label} ${p?.org ?? ''} ${p?.role ?? ''}`.toLowerCase().includes(q));
      const attn = !s.attentionOnly || d.kind !== 'person' || !!p?.flags.length;
      const outOfFocus = !!focus && !focus.has(d.id) && d.kind !== 'me';
      g.classed('dim', hidden || (d.kind === 'person' && (!matches || !attn)) || outOfFocus)
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
  const want = nodes.filter((n) => n.person && (n.person.ring <= 2 || n.person.flags.length || n.person.worlds.length > 1 || n.person.tier === 1));
  const rank = (n: GNode) => n.person!.ring - n.person!.flags.length - (n.person!.worlds.length > 1 ? 1 : 0);
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

function initials(name: string) {
  return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function nodeClass(d: GNode) {
  const p = d.person;
  const c = ['node', d.kind];
  if (p) {
    c.push(`ring-${p.ring}`);
    if (!p.met) c.push('unmet');
    if (p.flags.length) c.push('flagged');
    if (p.worlds.length > 1) c.push('bridge');
  }
  return c.join(' ');
}
