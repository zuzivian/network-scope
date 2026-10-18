// The network model.
//
// Structure comes from the graph file (contexts tree + people + direct links).
// CRM state comes from the Notion trackers and is merged onto the same people.
// Topology: Nat → worlds → sub-contexts → people, plus person↔person links.
// People in several contexts are what tie the graph together.

/** 1 core · 2 active · 3 acquainted · 4 target (not yet met / to reach out) */
export type Ring = 1 | 2 | 3 | 4;

export const RINGS: { ring: Ring; label: string }[] = [
  { ring: 1, label: 'Core' },
  { ring: 2, label: 'Active' },
  { ring: 3, label: 'Acquainted' },
  { ring: 4, label: 'Targets' },
];

export type Flag = 'due' | 'thanks' | 'quiet';

export const FLAG_LABEL: Record<Flag, string> = {
  due: 'Follow-up due',
  thanks: 'Thank-you owed',
  quiet: 'Gone quiet',
};

export interface Context {
  id: string;
  name: string;
  parent: string; // the "me" id for a world
  years?: string;
  role?: string;
  world: string;
  depth: number; // 1 = world
  members: number;
}

export interface Person {
  id: string;
  name: string;
  contexts: string[];
  world: string; // primary world, from the first context
  worlds: string[];
  ring: Ring;
  met: boolean;
  org?: string;
  role?: string;
  status?: string;
  tier?: number;
  lastContact?: string;
  followUp?: string;
  nextAction?: string;
  notes?: string;
  thankYouOwed: boolean;
  halfLife: number;
  quietAfter: number | null;
  sources: string[];
  sample: boolean;
}

export interface Derived {
  daysSince: number | null;
  /** 1 = just spoke, halves every halfLife days. null = no date recorded. */
  warmth: number | null;
  flags: Flag[];
  daysOverdue: number | null;
}

export type Node = Person & Derived;

export type LinkKind = 'part' | 'member' | 'partner' | 'family' | 'intro' | 'knows';

export interface Link {
  a: string;
  b: string;
  kind: LinkKind;
  label?: string;
}

export const LINK_LABEL: Record<LinkKind, string> = {
  part: 'part of',
  member: 'member',
  partner: 'partner',
  family: 'family',
  intro: 'intro path',
  knows: 'knows',
};

export interface Network {
  today: string;
  me: { id: string; name: string };
  worlds: Context[];
  contexts: Context[];
  people: Node[];
  links: Link[];
  sources: { name: string; rows: number; sample: boolean; skipped?: boolean }[];
  excluded: number;
}

// ---------- Value normalisation (Notion export shapes) ----------

type Row = Record<string, unknown>;

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(', ') || undefined;
  if (typeof v === 'object' && 'name' in (v as Row)) return str((v as Row).name);
  return undefined;
}

/** Accepts "2026-10-01", "2026-10-01T…" or {start: "…"}. */
function date(v: unknown): string | undefined {
  if (v && typeof v === 'object' && 'start' in (v as Row)) return date((v as Row).start);
  return str(v)?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
}

function bool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const s = str(v)?.toLowerCase();
  return s === '__yes__' || s === 'yes' || s === 'true' || s === 'checked';
}

function tier(v: unknown): number | undefined {
  const m = str(v)?.match(/\d/);
  return m ? Number(m[0]) : undefined;
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** "Intro via Priya Raman" → ["Priya Raman"] */
function viaNames(...texts: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const t of texts) for (const m of t?.matchAll(/\bvia\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)/g) ?? []) out.push(m[1]);
  return out;
}

// ---------- Notion adapters ----------

/** A person as a tracker sees them; contexts are names resolved against the graph later. */
interface Tracked {
  id: string;
  name: string;
  status?: string;
  ring: Ring;
  met: boolean;
  org?: string;
  role?: string;
  tier?: number;
  lastContact?: string;
  followUp?: string;
  nextAction?: string;
  notes?: string;
  thankYouOwed: boolean;
  halfLife: number;
  quietAfter: number | null;
  /** Free text that may name a context ("Tahoe cabin, Sept 2026", "GSB'27"). */
  hints: string[];
  company?: string;
  mentions: string[];
  source: 'Networking Tracker' | 'Classmate Network';
}

const NETWORKING_RING: Record<string, Ring> = {
  'meeting complete': 2, 'had chat': 2, 'following up': 3, warm: 3, 'meeting scheduled': 3, 'to reach out': 4,
};

function fromNetworkingTracker(rows: Row[]): { people: Tracked[]; excluded: number } {
  const people: Tracked[] = [];
  let excluded = 0;
  for (const r of rows) {
    const name = str(r['Name']);
    const status = str(r['Status']);
    if (!name) { excluded++; continue; }
    const nextAction = str(r['Next Action']);
    const notes = str(r['Notes']);
    const company = str(r['Company']);
    const howMet = str(r['How We Met']);
    const s = status?.toLowerCase() ?? '';
    const closed = s === 'closed';
    const lastContacted = date(r['Last Contacted']);
    people.push({
      id: slug(name), name, status,
      ring: closed ? 3 : NETWORKING_RING[s] ?? 3,
      // A closed row is someone you dealt with, unless there was never any contact.
      met: closed ? !!lastContacted : s !== 'to reach out' && s !== '',
      org: company, role: str(r['Role']), tier: tier(r['Tier']),
      lastContact: lastContacted, followUp: closed ? undefined : date(r['Follow-up Date']),
      nextAction: /no follow-up needed/i.test(nextAction ?? '') ? undefined : nextAction,
      notes: [notes, howMet ? `How you met: ${howMet}` : undefined].filter(Boolean).join(' ') || undefined,
      thankYouOwed: /meeting complete|had chat/.test(s) && !bool(r['Thank You Sent']),
      halfLife: 21,
      quietAfter: /warm|following up|meeting complete|had chat/.test(s) ? 21 : null,
      hints: howMet ? [howMet] : [],
      company,
      mentions: viaNames(nextAction, notes, howMet),
      source: 'Networking Tracker',
    });
  }
  return { people, excluded };
}

const CLASSMATE_RING: Record<string, Ring> = { 'regular contact': 2, 'following up': 3, 'met once': 3, 'not yet met': 4 };

function fromClassmateNetwork(rows: Row[]): Tracked[] {
  return rows.flatMap((r): Tracked[] => {
    const name = str(r['Name']);
    if (!name) return [];
    const status = str(r['Status']);
    const s = status?.toLowerCase() ?? '';
    const followUp = str(r['Follow Up']);
    return [{
      id: slug(name), name, status,
      ring: CLASSMATE_RING[s] ?? 3,
      met: s !== 'not yet met',
      role: 'GSB MBA 2028',
      lastContact: [date(r['Last Met']), date(r['Last Touchpoint'])].filter(Boolean).sort().pop(),
      followUp: date(r['Follow-up Date']),
      nextAction: followUp,
      thankYouOwed: false,
      halfLife: s === 'regular contact' ? 45 : 30,
      quietAfter: s === 'regular contact' ? 45 : s === 'following up' ? 14 : null,
      notes: str(r['Where Met']) ? `Met: ${str(r['Where Met'])}` : undefined,
      hints: [str(r['Where Met']) ?? '', str(r['Section']) ? `Section ${str(r['Section'])!.replace(/^section\s*/i, '')}` : '', 'classmate'].filter(Boolean),
      mentions: viaNames(followUp),
      source: 'Classmate Network',
    }];
  });
}

// ---------- Graph file ----------

export interface GraphFile {
  me: { id: string; name: string };
  contexts: { id: string; name: string; parent: string; years?: string; role?: string }[];
  people: {
    id: string; name: string; contexts: string[]; closeness?: number; met?: boolean;
    org?: string; role?: string; tier?: number; lastContact?: string; followUp?: string; nextAction?: string; notes?: string;
    sources?: string[];
  }[];
  links: { a: string; b: string; kind: LinkKind; label?: string }[];
}

// ---------- Derivation ----------

export function localToday(): string {
  const q = new URLSearchParams(location.search).get('today');
  if (q && /^\d{4}-\d{2}-\d{2}$/.test(q)) return q;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
}

const dayMs = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / dayMs);

/** Next actions that say the loop is closed ("Thanked after…", "No follow-up needed"). */
const CLOSED_LOOP = /\b(thanked|thank-you done|done\b|no (further |active )?follow-?up|not revisiting|none (needed|pending)|no need to pursue|on hold)/i;

function derive(p: Person, today: string): Node {
  const daysSince = p.lastContact ? Math.max(0, daysBetween(p.lastContact, today)) : null;
  const warmth = daysSince == null ? null : Math.pow(0.5, daysSince / p.halfLife);
  const flags: Flag[] = [];
  let daysOverdue: number | null = null;
  const closed = CLOSED_LOOP.test(p.nextAction ?? '');
  if (!closed && p.followUp && p.followUp <= today) { flags.push('due'); daysOverdue = daysBetween(p.followUp, today); }
  if (p.thankYouOwed) flags.push('thanks');
  if (!closed && p.quietAfter != null && daysSince != null && daysSince > p.quietAfter && !(p.followUp && p.followUp > today)) flags.push('quiet');
  return { ...p, daysSince, warmth, flags, daysOverdue };
}

export interface Sources {
  graph: { data: GraphFile; sample: boolean; label?: string };
  imports: { name: string; rows: number }[];
  networking: { rows: Row[]; sample: boolean };
  classmates: { rows: Row[]; sample: boolean };
  encounters: Row[];
  rules: { aliases: Record<string, string>; whereMet: { match: string; context: string }[] };
}

export function buildNetwork(src: Sources): Network {
  const today = localToday();
  const g = src.graph.data;

  // Contexts: resolve world + depth by walking parents.
  const ctxById = new Map<string, Context>();
  const raw = new Map(g.contexts.map((c) => [c.id, c]));
  const resolve = (id: string): Context | undefined => {
    if (ctxById.has(id)) return ctxById.get(id);
    const c = raw.get(id);
    if (!c) return undefined;
    const parent = c.parent === g.me.id ? undefined : resolve(c.parent);
    const ctx: Context = { ...c, world: parent?.world ?? c.id, depth: (parent?.depth ?? 0) + 1, members: 0 };
    ctxById.set(id, ctx);
    return ctx;
  };
  g.contexts.forEach((c) => resolve(c.id));
  const byName = new Map([...ctxById.values()].map((c) => [slug(c.name), c]));
  const findOrMakeContext = (name: string, under: string): string => {
    const hit = ctxById.get(slug(name)) ?? byName.get(slug(name));
    if (hit) return hit.id;
    const parent = ctxById.get(under);
    const ctx: Context = {
      id: slug(name), name, parent: parent ? under : g.me.id,
      world: parent?.world ?? slug(name), depth: (parent?.depth ?? 0) + 1, members: 0,
    };
    ctxById.set(ctx.id, ctx);
    byName.set(slug(name), ctx);
    return ctx.id;
  };

  // People from the graph file.
  const graphSource = src.graph.sample ? 'Sample graph' : src.graph.label ?? 'Imported';
  const people = new Map<string, Person>();
  for (const p of g.people) {
    const closeness = Math.min(4, Math.max(1, p.closeness ?? 3)) as Ring;
    people.set(p.id, {
      id: p.id, name: p.name, contexts: p.contexts.filter((c) => ctxById.has(c)), world: '', worlds: [],
      ring: closeness, met: p.met ?? true,
      org: p.org, role: p.role, tier: p.tier, lastContact: p.lastContact, followUp: p.followUp,
      nextAction: p.nextAction, notes: p.notes, thankYouOwed: false,
      halfLife: closeness === 1 ? 14 : 30, quietAfter: null,
      sources: p.sources ?? [graphSource], sample: src.graph.sample,
    });
  }

  // Tracker rows. Fictional fixtures never mix into a real graph.
  const useTracker = (t: { sample: boolean }) => !t.sample || src.graph.sample;
  const sources: Network['sources'] = [
    { name: graphSource, rows: g.people.filter((p) => !p.sources || p.sources.includes(graphSource)).length, sample: src.graph.sample },
    ...src.imports.map((i) => ({ ...i, sample: false })),
    { name: 'Networking Tracker', rows: src.networking.rows.length, sample: src.networking.sample, skipped: !useTracker(src.networking) },
    { name: 'Classmate Network', rows: src.classmates.rows.length, sample: src.classmates.sample, skipped: !useTracker(src.classmates) },
  ];
  const net = fromNetworkingTracker(useTracker(src.networking) ? src.networking.rows : []);
  const tracked = [...net.people, ...fromClassmateNetwork(useTracker(src.classmates) ? src.classmates.rows : [])];

  // Names differ across sources ("Chua Xianyi", "Nick", "Dominique (Dom) Castanheira"): resolve to one id.
  const stripParens = (n: string) => n.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const byPersonName = new Map<string, string>();
  for (const p of people.values()) {
    byPersonName.set(slug(p.name), p.id);
    byPersonName.set(slug(stripParens(p.name)), p.id);
  }
  const resolveId = (name: string): string => {
    const alias = src.rules.aliases[name];
    if (alias) return alias;
    const n = slug(name);
    const base = stripParens(name);
    const words = base.split(/\s+/);
    const nick = name.match(/\(([^)]+)\)/)?.[1];
    const tries = [n, slug(base), nick && words.length > 1 ? slug(`${nick} ${words[words.length - 1]}`) : '',
      words.length === 2 ? slug(`${words[1]} ${words[0]}`) : ''];
    for (const t of tries) {
      if (!t) continue;
      const hit = people.has(t) ? t : byPersonName.get(t);
      if (hit) return hit;
    }
    // Same surname and a short/long form of the first name ("Dom" / "Dominique"), if that's unambiguous.
    if (words.length >= 2) {
      const first = words[0].toLowerCase(), last = words[words.length - 1].toLowerCase();
      const cands = [...people.values()].filter((p) => {
        const w = stripParens(p.name).toLowerCase().split(/\s+/);
        if (w.length < 2 || w[w.length - 1] !== last) return false;
        const f = w[0];
        return Math.min(f.length, first.length) >= 3 && (f.startsWith(first) || first.startsWith(f));
      });
      if (cands.length === 1) return cands[0].id;
    }
    return n;
  };
  const rules = src.rules.whereMet.map((r) => ({ re: new RegExp(r.match, 'i'), context: r.context }));
  const contextsFor = (hints: string[]): string[] => {
    const out: string[] = [];
    for (const h of hints) {
      const specific = rules.filter((r) => r.context !== 'gsb' && r.re.test(h)).map((r) => r.context);
      out.push(...(specific.length ? specific : rules.filter((r) => r.re.test(h)).map((r) => r.context)));
    }
    const known = [...new Set(out)].filter((c) => ctxById.has(c));
    // "gsb" is only a fallback when nothing more specific matched.
    return known.length > 1 ? known.filter((c) => c !== 'gsb') : known;
  };
  // A company gets its own box only when two or more people share it, or it already exists.
  const companyCount = new Map<string, number>();
  for (const t of tracked) if (t.company) companyCount.set(slug(t.company), (companyCount.get(slug(t.company)) ?? 0) + 1);

  const links: Link[] = g.links.map((l) => ({ ...l }));
  const mentions: { from: string; name: string }[] = [];
  for (const t of tracked) {
    t.id = resolveId(t.name);
    const ctxIds = contextsFor(t.hints);
    if (t.company) {
      const k = slug(t.company);
      if (ctxById.has(k) || byName.has(k) || (companyCount.get(k) ?? 0) >= 2) ctxIds.push(findOrMakeContext(t.company, 'industry'));
      else if (!ctxIds.length) ctxIds.push('industry');
    }
    const prev = people.get(t.id);
    const trackerSample = t.source === 'Networking Tracker' ? src.networking.sample : src.classmates.sample;
    // CRM state from the tracker wins; structure from the graph file is kept.
    people.set(t.id, {
      id: t.id, name: prev?.name ?? t.name, world: '', worlds: [],
      // Closest view wins when two trackers (or vault + tracker) disagree.
      ring: (prev ? Math.min(prev.ring, t.ring) : t.ring) as Ring, met: t.met || !!prev?.met, status: t.status ?? prev?.status, tier: t.tier ?? prev?.tier,
      org: t.org ?? prev?.org, role: t.role ?? prev?.role,
      lastContact: [t.lastContact, prev?.lastContact].filter(Boolean).sort().pop(),
      // The Networking Tracker is the live CRM: its next action outranks the classmate log's.
      ...(prev?.sources.includes('Networking Tracker')
        ? { followUp: prev.followUp ?? t.followUp, nextAction: prev.nextAction ?? t.nextAction }
        : { followUp: t.followUp ?? prev?.followUp, nextAction: t.nextAction ?? prev?.nextAction }),
      notes: [prev?.notes, t.notes].filter(Boolean).join(' ') || undefined,
      thankYouOwed: t.thankYouOwed, halfLife: t.halfLife, quietAfter: t.quietAfter,
      contexts: [...new Set([...(prev?.contexts ?? []), ...ctxIds])],
      sources: [...new Set([...(prev?.sources ?? []), t.source])],
      sample: (prev?.sample ?? true) && trackerSample,
    });
    t.mentions.forEach((name) => mentions.push({ from: t.id, name }));
  }
  for (const m of mentions) {
    const other = people.get(resolveId(m.name));
    if (other && other.id !== m.from) links.push({ a: other.id, b: m.from, kind: 'intro', label: 'Named as warm path in Notion' });
  }

  // Encounters (Notion): latest date per person, and "met together" links for small groups.
  for (const e of src.encounters) {
    const when = date(e['Date']);
    const title = str(e['Name']) ?? 'Encounter';
    const names = (str(e['People']) ?? '').split(';').map((x) => x.replace(/\(.*?\)/g, '').trim())
      .filter((x) => x && !/nathaniel wong|unknown|'s |guests/i.test(x));
    const ids = names.map(resolveId).filter((id) => people.has(id));
    for (const id of ids) {
      const p = people.get(id)!;
      if (when && (!p.lastContact || when > p.lastContact)) p.lastContact = when;
      p.met = true;
    }
    if (ids.length >= 2 && ids.length <= 7) {
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        links.push({ a: ids[i], b: ids[j], kind: 'knows', label: `Together at “${title}”${when ? ` (${when})` : ''}` });
      }
    }
  }

  // Worlds per person, member counts, structural links.
  for (const p of people.values()) {
    if (!p.contexts.length) p.contexts = [findOrMakeContext('Unsorted', g.me.id)];
    p.worlds = [...new Set(p.contexts.map((c) => ctxById.get(c)!.world))];
    p.world = p.worlds[0];
    for (const c of p.contexts) {
      ctxById.get(c)!.members++;
      links.push({ a: c, b: p.id, kind: 'member' });
    }
  }
  const contexts = [...ctxById.values()];
  for (const c of contexts) links.push({ a: c.parent, b: c.id, kind: 'part' });

  // Drop dangling and duplicate links.
  const exists = (id: string) => id === g.me.id || people.has(id) || ctxById.has(id);
  const seen = new Set<string>();
  const deduped = links.filter((l) => {
    if (!exists(l.a) || !exists(l.b)) return false;
    const key = `${[l.a, l.b].sort().join('|')}|${isSocial(l) ? 'social' : l.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    today, me: g.me,
    worlds: contexts.filter((c) => c.depth === 1),
    contexts,
    people: [...people.values()].map((p) => derive(p, today)),
    links: deduped,
    sources,
    excluded: net.excluded,
  };
}

/** Person↔person links (and Nat↔partner); not structural membership. */
export function isSocial(l: Link): boolean {
  return l.kind !== 'member' && l.kind !== 'part';
}

/**
 * Shortest chain of people from someone Nat has met to `target`, over social links.
 * Returns ids [first contact, …, target], or null if there's no chain.
 */
export function warmPath(net: Network, target: string): string[] | null {
  const byId = new Map(net.people.map((p) => [p.id, p]));
  const t = byId.get(target);
  if (!t || t.met) return null;
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string) => { if (!adj.has(a)) adj.set(a, []); adj.get(a)!.push(b); };
  for (const l of net.links) if (isSocial(l)) { add(l.a, l.b); add(l.b, l.a); }
  const prev = new Map<string, string | null>();
  const queue: string[] = [];
  for (const p of net.people) if (p.met) { prev.set(p.id, null); queue.push(p.id); }
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === target) break;
    for (const n of adj.get(cur) ?? []) if (!prev.has(n) && byId.has(n)) { prev.set(n, cur); queue.push(n); }
  }
  if (!prev.has(target)) return null;
  const path: string[] = [];
  for (let c: string | null = target; c; c = prev.get(c) ?? null) path.unshift(c);
  return path;
}
