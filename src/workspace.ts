// Browser mode: a visitor's whole network lives in this browser's IndexedDB.
// Files are parsed on the device (src/importers) and merged here; nothing is sent anywhere.
import { sameOrg, type TimelineEntry } from './importers/linkedin';
import type { ImportKind, ImportResult } from './importers/types';
import type { GraphFile, LinkKind, Sources } from './model';
import { slug } from './model';
import type { Contact } from './sort';

export interface WorkspacePerson {
  id: string;
  name: string;
  raw?: string;
  /** Contexts set by imports (groups, companies). Sort decisions and tag rules are applied on top. */
  contexts: string[];
  closeness: number;
  met: boolean;
  org?: string;
  role?: string;
  rank?: string;
  tags: string[];
  connectedOn?: string;
  status?: string;
  notes?: string;
  url?: string;
  tier?: number;
  /** Import ids this person came from. */
  sources: string[];
}

export interface Decision { contexts?: string[]; exclude?: boolean; skip?: boolean; at: string }

export interface Workspace {
  version: 1;
  me: { id: 'me'; name: string };
  contexts: { id: string; name: string; parent: string; years?: string; role?: string }[];
  people: WorkspacePerson[];
  links: { a: string; b: string; kind: LinkKind; label?: string }[];
  /** Upper-cased tag -> context ids ("140" -> ["sqn140"]). */
  tagRules: Record<string, string[]>;
  decisions: Record<string, Decision>;
  imports: { id: string; kind: ImportKind | 'workspace'; source: string; at: string; people: number }[];
  /** Pairs of person ids you said are different people ("a|b", sorted). */
  notDuplicates?: string[];
  /** When this map was last downloaded as a backup (ISO). */
  lastBackupAt?: string;
  /** Your own schools and jobs (LinkedIn Education.csv / Positions.csv), used to place connections. */
  timeline?: TimelineEntry[];
  /** CRM tracker rows and their matching rules, carried over from local files (see workspaceFromSources). */
  crm?: { networking: Row[]; classmates: Row[]; encounters: Row[]; rules: Sources['rules'] };
  updatedAt: string;
}

type Row = Record<string, unknown>;

export function emptyWorkspace(name = 'Me'): Workspace {
  return { version: 1, me: { id: 'me', name }, contexts: [], people: [], links: [], tagRules: {}, decisions: {}, imports: [], updatedAt: new Date().toISOString() };
}

// ---------- Storage (IndexedDB, falling back to memory) ----------

const DB = 'network-scope';
const STORE = 'kv';
const KEY = 'workspace';
let memory: Workspace | null = null;
export let storageAvailable = true;

function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((ok, fail) => {
    const r = fn(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

export async function loadWorkspace(): Promise<Workspace> {
  try {
    const ws = (await tx('readonly', (s) => s.get(KEY))) as Workspace | undefined;
    return ws ?? memory ?? emptyWorkspace();
  } catch {
    storageAvailable = false;
    return memory ?? emptyWorkspace();
  }
}

export async function saveWorkspace(ws: Workspace): Promise<void> {
  ws.updatedAt = new Date().toISOString();
  memory = ws;
  try { await tx('readwrite', (s) => s.put(ws, KEY)); } catch { storageAvailable = false; }
  if (ws.people.length && !asked) { asked = true; void protectStorage(true); }
}

/**
 * Ask the browser to keep this site's storage instead of clearing it under pressure (or, in
 * Safari, after 7 days without a visit). Browsers decide for themselves, and Firefox asks the
 * person, so this never blocks: `check` only reads the current state, `ask` requests it in the
 * background. 'best-effort' means the map can still be cleared, so a backup matters.
 */
export type Protection = 'unknown' | 'persisted' | 'best-effort';
export let protection: Protection = 'unknown';
let asked = false;
export async function protectStorage(ask = false): Promise<Protection> {
  const s = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!s?.persisted) return (protection = 'best-effort');
  try {
    const timeout = new Promise<boolean>((ok) => setTimeout(() => ok(false), 800));
    protection = (await Promise.race([s.persisted(), timeout])) ? 'persisted' : 'best-effort';
    if (ask && protection !== 'persisted' && s.persist) {
      s.persist().then((yes) => { if (yes) protection = 'persisted'; }, () => undefined);
    }
  } catch {
    protection = 'best-effort';
  }
  return protection;
}

/** Download the map as a backup file and remember when. */
export async function downloadBackup(ws: Workspace): Promise<void> {
  ws.lastBackupAt = new Date().toISOString();
  await saveWorkspace(ws);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(exportWorkspace(ws));
  a.download = `network-scope-backup-${ws.lastBackupAt.slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function clearWorkspace(): Promise<void> {
  memory = null;
  try { await tx('readwrite', (s) => s.delete(KEY)); } catch { /* nothing stored */ }
}

// ---------- Merging an import ----------

export interface MergeOptions {
  /** Existing world id, or a new world name to create. */
  world: { id?: string; newName?: string };
  groupContexts: boolean;
  companyContexts: boolean;
}

const DEFAULT_WORLD: Record<ImportKind, string> = {
  linkedin: 'Work', vcard: 'Contacts', csv: 'Contacts', whatsapp: 'WhatsApp', facebook: 'Facebook', instagram: 'Instagram', calendar: 'Calendar',
};
export const defaultWorldName = (k: ImportKind) => DEFAULT_WORLD[k];

function ensureContext(ws: Workspace, name: string, parent: string): string {
  const s = slug(name) || 'context';
  // Reuse a context with the same name anywhere ("Family" category -> the Family world).
  const same = ws.contexts.find((c) => slug(c.name) === s);
  if (same) return same.id;
  let id = s;
  for (let i = 2; ws.contexts.some((c) => c.id === id) || id === 'me'; i++) id = `${s}-${i}`;
  ws.contexts.push({ id, name, parent });
  return id;
}

function ringFor(kind: ImportKind, status?: string, meetings = 0): { closeness: number; met: boolean } {
  const s = (status ?? '').toLowerCase();
  if (meetings >= 8) return { closeness: 2, met: true };
  if (/not yet|to reach|prospect/.test(s)) return { closeness: 4, met: false };
  if (/regular|close|friend|meeting complete|had chat/.test(s)) return { closeness: 2, met: true };
  if (kind === 'instagram') return { closeness: 4, met: false };
  return { closeness: 3, met: true };
}

export function mergeImport(ws: Workspace, r: ImportResult, opt: MergeOptions): { added: number; updated: number; importId: string } {
  const importId = `${r.kind}-${Date.now().toString(36)}`;
  const world = opt.world.id ?? ensureContext(ws, opt.world.newName || DEFAULT_WORLD[r.kind], 'me');
  const groupCtx = new Map<string, string>();
  if (opt.groupContexts) for (const g of r.groups) groupCtx.set(g.name, ensureContext(ws, g.name, world));
  const orgCount = new Map<string, number>();
  for (const p of r.people) if (p.org) orgCount.set(slug(p.org), (orgCount.get(slug(p.org)) ?? 0) + 1);

  const byId = new Map(ws.people.map((p) => [p.id, p]));
  const meSlug = slug(ws.me.name);
  // Your own schools and jobs place people from any source (by company); LinkedIn also by connection date.
  const chapter = placeByTimeline(ws.timeline ?? []);
  let added = 0, updated = 0;
  for (const p of r.people) {
    const id = slug(p.name);
    if (!id || id === meSlug) continue;
    const ctx = p.groups.map((g) => groupCtx.get(g)).filter((x): x is string => !!x);
    // Someone from one of your own schools or jobs goes in that world, not the catch-all.
    const own = chapter(p.org, p.role, p.connectedOn);
    if (own) ctx.push(ensureContext(ws, own, 'me'));
    else if (opt.companyContexts && p.org && ((orgCount.get(slug(p.org)) ?? 0) >= 2 || ws.contexts.some((c) => slug(c.name) === slug(p.org!)))) {
      ctx.push(ensureContext(ws, p.org, world)); // a company group already on your map gets them too
    }
    if (!ctx.length) ctx.push(world);
    const ring = ringFor(r.kind, p.status, p.meetings);
    // Same name but a clearly different company: keep them apart and let the user decide (see findDuplicates).
    let pid = id;
    for (let i = 2; byId.has(pid) && byId.get(pid)!.org && p.org && !sameOrg(byId.get(pid)!.org!, p.org); i++) pid = `${id}-${i}`;
    const prev = byId.get(pid);
    if (!prev) {
      const np: WorkspacePerson = {
        id: pid, name: p.name, raw: p.raw, contexts: ctx, closeness: ring.closeness, met: ring.met,
        org: p.org, role: p.role, rank: p.rank, tags: p.tags, connectedOn: p.connectedOn,
        status: p.status, notes: p.notes, url: p.url, sources: [importId],
      };
      ws.people.push(np);
      byId.set(pid, np);
      added++;
      continue;
    }
    // Same name seen again: union what we know, keep what was there first.
    prev.contexts = [...new Set([...prev.contexts.filter((c) => c !== world || ctx.includes(c)), ...ctx])];
    prev.org ??= p.org; prev.role ??= p.role; prev.rank ??= p.rank; prev.url ??= p.url; prev.status ??= p.status;
    prev.tags = [...new Set([...prev.tags, ...p.tags])];
    prev.connectedOn = [prev.connectedOn, p.connectedOn].filter(Boolean).sort()[0];
    prev.closeness = Math.min(prev.closeness, ring.closeness);
    prev.met ||= ring.met;
    prev.sources = [...new Set([...prev.sources, importId])];
    updated++;
  }
  ws.imports.push({ id: importId, kind: r.kind, source: r.source, at: new Date().toISOString(), people: r.people.length });
  return { added, updated, importId };
}

/**
 * Where a LinkedIn connection belongs in your own timeline, by evidence:
 * their company is one of your schools or employers, or you connected during a past
 * school period while not also in a job. Returns the organisation (a world name), or null.
 */
export function placeByTimeline(timeline: TimelineEntry[]) {
  const today = new Date().toISOString().slice(0, 10);
  const jobs = timeline.filter((t) => t.kind === 'job');
  const pastSchools = timeline.filter((t) => t.kind === 'school' && t.end && t.end < today);
  const canonical = (org: string) => timeline.find((t) => sameOrg(t.org, org))?.org ?? org;
  return (org?: string, role?: string, connectedOn?: string): string | null => {
    const mine = timeline.find((t) => (org && sameOrg(org, t.org)) || (role && role.toLowerCase().includes(t.org.toLowerCase())));
    if (mine) return canonical(mine.org);
    if (!connectedOn || jobs.some((t) => t.start <= connectedOn && connectedOn <= (t.end ?? '9999'))) return null;
    const at = [...new Set(pastSchools.filter((t) => t.start <= connectedOn && connectedOn <= t.end!).map((t) => canonical(t.org)))];
    return at.length === 1 ? at[0] : null;
  };
}

// ---------- Possible duplicates ----------

const NICK: Record<string, string> = {
  bob: 'robert', rob: 'robert', bobby: 'robert', bill: 'william', will: 'william', liz: 'elizabeth', beth: 'elizabeth',
  kate: 'katherine', katie: 'katherine', kat: 'katherine', cathy: 'catherine', jim: 'james', jimmy: 'james', mike: 'michael',
  dave: 'david', dan: 'daniel', danny: 'daniel', tom: 'thomas', tony: 'anthony', matt: 'matthew', nick: 'nicholas',
  chris: 'christopher', alex: 'alexander', sam: 'samuel', ben: 'benjamin', joe: 'joseph', jen: 'jennifer', jenny: 'jennifer',
  steve: 'steven', andy: 'andrew', drew: 'andrew', ed: 'edward', ted: 'edward', rick: 'richard', dick: 'richard',
  greg: 'gregory', jon: 'jonathan', josh: 'joshua', meg: 'margaret', peggy: 'margaret', sue: 'susan', vicky: 'victoria',
};
const firstKey = (n: string) => { const f = n.toLowerCase().replace(/[^a-z]/g, ''); return NICK[f] ?? f; };

export interface Duplicate { a: WorkspacePerson; b: WorkspacePerson; why: string }

/** People who may be the same person: same name at different companies, or a nickname of the same name. */
export function findDuplicates(ws: Workspace): Duplicate[] {
  const no = new Set(ws.notDuplicates ?? []);
  const out: Duplicate[] = [];
  const bySurname = new Map<string, WorkspacePerson[]>();
  for (const p of ws.people) {
    const w = p.name.trim().split(/\s+/);
    if (w.length < 2) continue;
    const k = w[w.length - 1].toLowerCase();
    bySurname.set(k, [...(bySurname.get(k) ?? []), p]);
  }
  for (const group of bySurname.values()) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const a = group[i], b = group[j];
      if (no.has([a.id, b.id].sort().join('|'))) continue;
      const fa = firstKey(a.name.split(/\s+/)[0]), fb = firstKey(b.name.split(/\s+/)[0]);
      if (slug(a.name) === slug(b.name)) out.push({ a, b, why: `Same name, different companies (${a.org} · ${b.org})` });
      else if (fa === fb || (Math.min(fa.length, fb.length) >= 3 && (fa.startsWith(fb) || fb.startsWith(fa)))) {
        out.push({ a, b, why: 'Nickname or short form of the same name' });
      }
    }
  }
  return out;
}

/** Merge `drop` into `keep`: union their groups, sources and tags; keep's details win. */
export function mergePeople(ws: Workspace, keepId: string, dropId: string) {
  const keep = ws.people.find((p) => p.id === keepId), drop = ws.people.find((p) => p.id === dropId);
  if (!keep || !drop) return;
  keep.contexts = [...new Set([...keep.contexts, ...drop.contexts])];
  keep.sources = [...new Set([...keep.sources, ...drop.sources])];
  keep.tags = [...new Set([...keep.tags, ...drop.tags])];
  keep.org ??= drop.org; keep.role ??= drop.role; keep.url ??= drop.url; keep.notes ??= drop.notes;
  keep.closeness = Math.min(keep.closeness, drop.closeness);
  keep.met ||= drop.met;
  ws.people = ws.people.filter((p) => p.id !== dropId);
  ws.links = ws.links.map((l) => ({ ...l, a: l.a === dropId ? keepId : l.a, b: l.b === dropId ? keepId : l.b })).filter((l) => l.a !== l.b);
  if (ws.decisions[dropId] && !ws.decisions[keepId]) ws.decisions[keepId] = ws.decisions[dropId];
  delete ws.decisions[dropId];
}

export function markNotDuplicate(ws: Workspace, a: string, b: string) {
  ws.notDuplicates = [...new Set([...(ws.notDuplicates ?? []), [a, b].sort().join('|')])];
}

/** Undo one import: drop it from everyone, and drop people nothing else vouches for. */
export function removeImport(ws: Workspace, importId: string) {
  ws.imports = ws.imports.filter((i) => i.id !== importId);
  ws.people = ws.people.filter((p) => {
    p.sources = p.sources.filter((s) => s !== importId);
    return p.sources.length > 0 || !!ws.decisions[p.id]?.contexts;
  });
  pruneContexts(ws);
}

/** Remove contexts with no people and no children (keeps worlds the user made by hand). */
export function pruneContexts(ws: Workspace) {
  for (let changed = true; changed;) {
    changed = false;
    const used = new Set<string>();
    for (const p of ws.people) for (const c of effectiveContexts(ws, p)) used.add(c);
    for (const c of ws.contexts) used.add(c.parent);
    Object.values(ws.tagRules).flat().forEach((c) => used.add(c));
    const keep = ws.contexts.filter((c) => used.has(c.id) || c.parent === 'me');
    if (keep.length !== ws.contexts.length) { ws.contexts = keep; changed = true; }
  }
}

// ---------- Tags ----------

export function suggestedFromTags(ws: Workspace, p: WorkspacePerson): string[] {
  return [...new Set(p.tags.flatMap((t) => ws.tagRules[t.toUpperCase()] ?? []))];
}

export function effectiveContexts(ws: Workspace, p: WorkspacePerson): string[] {
  const d = ws.decisions[p.id];
  if (d?.contexts?.length) return d.contexts;
  const fromTags = suggestedFromTags(ws, p);
  if (!fromTags.length) return p.contexts;
  // A tag placement replaces the catch-all import bucket, but keeps real groups.
  const worlds = new Set(ws.contexts.filter((c) => c.parent === 'me').map((c) => c.id));
  return [...new Set([...p.contexts.filter((c) => !worlds.has(c)), ...fromTags])];
}

export function discoveredTags(ws: Workspace): { tag: string; count: number; examples: string[]; mapped: string[] }[] {
  const m = new Map<string, { count: number; examples: string[] }>();
  for (const p of ws.people) for (const t of p.tags) {
    const k = t.toUpperCase();
    const e = m.get(k) ?? { count: 0, examples: [] };
    e.count++;
    if (e.examples.length < 3) e.examples.push(p.name);
    m.set(k, e);
  }
  return [...m.entries()].map(([tag, e]) => ({ tag, ...e, mapped: ws.tagRules[tag] ?? [] }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// ---------- To the model ----------

export function toSources(ws: Workspace): Sources {
  const label = new Map(ws.imports.map((i) => [i.id, i.source]));
  const people = ws.people
    .filter((p) => !ws.decisions[p.id]?.exclude)
    .map((p) => ({
      id: p.id, name: p.name, contexts: effectiveContexts(ws, p), closeness: p.closeness, met: p.met,
      org: p.org, role: p.role ?? p.rank, tier: p.tier,
      notes: [p.notes, p.connectedOn ? `Connected ${p.connectedOn}.` : '', p.url ?? ''].filter(Boolean).join(' ') || undefined,
      sources: p.sources.map((s) => label.get(s) ?? 'Import'),
    }));
  const graph: GraphFile = { me: ws.me, contexts: ws.contexts, people, links: ws.links };
  return {
    graph: { data: graph, sample: false },
    imports: ws.imports.map((i) => ({ name: i.source, rows: i.people })),
    networking: { rows: ws.crm?.networking ?? [], sample: false },
    classmates: { rows: ws.crm?.classmates ?? [], sample: false },
    encounters: ws.crm?.encounters ?? [],
    rules: ws.crm?.rules ?? { aliases: {}, whereMet: [] },
  };
}

export function workspaceContacts(ws: Workspace): Contact[] {
  const worlds = new Set(ws.contexts.filter((c) => c.parent === 'me').map((c) => c.id));
  return ws.people.map((p) => {
    const fromTags = suggestedFromTags(ws, p);
    const onlyBuckets = p.contexts.every((c) => worlds.has(c));
    return {
      key: p.id, name: p.name, raw: p.raw ?? p.name, rank: p.rank ?? null, tags: p.tags,
      suggested: fromTags.length ? fromTags : onlyBuckets ? [] : p.contexts,
      lastContact: null, personId: p.id, inVault: false,
      queue: fromTags.length ? 'suggested' : onlyBuckets ? 'unplaced' : 'placed',
      org: p.org,
    } as Contact;
  });
}

// ---------- Backup ----------

export function exportWorkspace(ws: Workspace): Blob {
  return new Blob([JSON.stringify(ws, null, 1)], { type: 'application/json' });
}

export function parseWorkspace(text: string): Workspace {
  const ws = JSON.parse(text) as Workspace;
  if (ws?.version !== 1 || !Array.isArray(ws.people) || !Array.isArray(ws.contexts)) throw new Error('Not a Network Scope backup file.');
  ws.tagRules ??= {}; ws.decisions ??= {}; ws.imports ??= []; ws.links ??= [];
  return ws;
}

/**
 * Local mode only: turn your local files (graph, importer overlays, CRM trackers) into a browser
 * workspace, so the same network works on the public site. Each source label becomes an import.
 * The result goes into a backup file on your own disk; nothing is sent anywhere.
 */
export function workspaceFromSources(src: Sources): Workspace {
  const g = src.graph.data;
  const ws = emptyWorkspace(g.me.name);
  const meId = g.me.id;
  const at = new Date().toISOString();
  ws.contexts = g.contexts.map((c) => ({ ...c, parent: c.parent === meId ? 'me' : c.parent }));
  const importFor = new Map<string, string>();
  const idFor = (label: string) => {
    let id = importFor.get(label);
    if (!id) {
      id = `workspace-${slug(label) || 'local'}`;
      importFor.set(label, id);
      ws.imports.push({ id, kind: 'workspace', source: label, at, people: 0 });
    }
    return id;
  };
  ws.people = g.people.map((p) => {
    const sources = (p.sources?.length ? p.sources : [src.graph.label ?? 'Local files']).map(idFor);
    return {
      id: p.id, name: p.name, contexts: p.contexts, closeness: p.closeness ?? 3, met: p.met ?? true, org: p.org, role: p.role,
      tags: [], notes: p.notes, tier: p.tier, sources,
    };
  });
  for (const i of ws.imports) i.people = ws.people.filter((p) => p.sources.includes(i.id)).length;
  ws.links = g.links.map((l) => ({ ...l, a: l.a === meId ? 'me' : l.a, b: l.b === meId ? 'me' : l.b }));
  ws.crm = { networking: src.networking.rows, classmates: src.classmates.rows, encounters: src.encounters, rules: src.rules };
  return ws;
}
