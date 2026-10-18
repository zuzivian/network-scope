import { forceCollide, forceSimulation, forceX, forceY, type SimulationNodeDatum } from 'd3-force';
import type { Context, Network, Node } from './model';

/** Ring boundaries as a fraction of the scope radius. Index 0 is the "me" disc. */
export const RING_EDGES = [0.12, 0.38, 0.6, 0.8, 1];

export interface Placed {
  node: Node;
  x: number;
  y: number;
  /** Bearing in degrees, 0 = north, clockwise. */
  bearing: number;
  size: number;
  /** Label shown without hover; decided by collision avoidance. */
  showLabel: boolean;
  labelLeft: boolean;
}

export interface Sector {
  circle: Context;
  start: number; // bearing degrees
  end: number;
  count: number;
}

const GAP = 6; // degrees between sectors

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

export const toXY = (bearing: number, r: number) => {
  const t = (bearing * Math.PI) / 180;
  return { x: r * Math.sin(t), y: -r * Math.cos(t) };
};

export function nodeSize(n: Node): number {
  if (n.ring === 1) return 7;
  if (n.tier === 1) return 6.5;
  if (n.tier === 2) return 5.5;
  return 4.5;
}

export function layout(net: Network, R: number): { placed: Placed[]; sectors: Sector[] } {
  const groups = net.worlds.map((c) => ({ circle: c, people: net.people.filter((p) => p.world === c.id) }));
  const weights = groups.map((g) => Math.pow(Math.max(5, g.people.length), 0.8));
  const total = weights.reduce((a, b) => a + b, 0);
  const avail = 360 - GAP * groups.length;

  // Centre the first sector (Career) on north.
  let cursor = -(weights[0] / total) * avail / 2;
  const sectors: Sector[] = [];
  const targets: (SimulationNodeDatum & { tx: number; ty: number; size: number; node: Node })[] = [];

  groups.forEach((g, i) => {
    const span = (weights[i] / total) * avail;
    const start = cursor;
    const end = cursor + span;
    cursor = end + GAP;
    sectors.push({ circle: g.circle, start, end, count: g.people.length });

    // Keep sub-groups (company, where met) adjacent; closer rings first within a group.
    const sorted = [...g.people].sort(
      (a, b) => a.contexts[0].localeCompare(b.contexts[0]) || a.ring - b.ring || a.name.localeCompare(b.name),
    );
    const pad = Math.min(4, span * 0.08);
    sorted.forEach((node, k) => {
      const bearing = start + pad + ((k + 0.5) * (span - 2 * pad)) / sorted.length;
      const inner = RING_EDGES[node.ring - 1] * R;
      const outer = RING_EDGES[node.ring] * R;
      const r = inner + (outer - inner) * (0.25 + 0.5 * hash(node.id));
      const { x, y } = toXY(bearing, r);
      targets.push({ x, y, tx: x, ty: y, size: nodeSize(node), node });
    });
  });

  // Nudge apart overlapping blips without losing their polar position.
  forceSimulation(targets)
    .force('x', forceX<(typeof targets)[number]>((d) => d.tx).strength(0.5))
    .force('y', forceY<(typeof targets)[number]>((d) => d.ty).strength(0.5))
    .force('collide', forceCollide<(typeof targets)[number]>((d) => d.size + 4).iterations(2))
    .stop()
    .tick(120);

  const placed: Placed[] = targets.map((t) => {
    const b = (Math.atan2(t.x!, -t.y!) * 180) / Math.PI;
    return { node: t.node, x: t.x!, y: t.y!, bearing: (b + 360) % 360, size: t.size, showLabel: false, labelLeft: (b + 360) % 360 > 180 };
  });
  placeLabels(placed, RING_EDGES[0] * R * 0.55);
  return { placed, sectors };
}

type Box = { x0: number; y0: number; x1: number; y1: number };
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

function labelBox(p: Placed, left: boolean): Box {
  const w = p.node.name.length * 5.9 + 2;
  const x0 = left ? p.x - p.size - 5 - w : p.x + p.size + 5;
  return { x0, y0: p.y - 7, x1: x0 + w, y1: p.y + 7 };
}

/** Greedy: closest and flagged people claim label space first; anything that would collide waits for hover/zoom. */
function placeLabels(placed: Placed[], meR: number) {
  const dots: Box[] = placed.map((p) => ({ x0: p.x - p.size - 1, y0: p.y - p.size - 1, x1: p.x + p.size + 1, y1: p.y + p.size + 1 }));
  const me: Box = { x0: -meR, y0: -meR, x1: meR, y1: meR };
  const taken: Box[] = [];
  const order = placed
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.node.ring <= 2 || p.node.flags.length > 0 || p.node.tier === 1)
    .sort((a, b) => a.p.node.ring - b.p.node.ring || b.p.node.flags.length - a.p.node.flags.length || (a.p.node.tier ?? 9) - (b.p.node.tier ?? 9));
  for (const { p, i } of order) {
    for (const left of [p.labelLeft, !p.labelLeft]) {
      const box = labelBox(p, left);
      if (overlaps(box, me) || taken.some((t) => overlaps(box, t)) || dots.some((d, j) => j !== i && overlaps(box, d))) continue;
      taken.push(box);
      p.showLabel = true;
      p.labelLeft = left;
      break;
    }
  }
}
