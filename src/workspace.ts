// Browser mode: a visitor's whole network lives in this browser's IndexedDB.
// Files are parsed on the device (src/importers) and merged here; nothing is sent anywhere.
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
  lastContact?: string;
  connectedOn?: string;
  status?: string;
  notes?: string;
  url?: string;
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
  updatedAt: string;
}

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
  linkedin: 'Work', vcard: 'Contacts', csv: 'Contacts', whatsapp: 'WhatsApp', facebook: 'Facebook', instagram: 'Instagram',
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

function ringFor(kind: ImportKind, status?: string): { closeness: number; met: boolean } {
  const s = (status ?? '').toLowerCase();
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
  let added = 0, updated = 0;
  for (const p of r.people) {
    const id = slug(p.name);
    if (!id || id === meSlug) continue;
    const ctx = p.groups.map((g) => groupCtx.get(g)).filter((x): x is string => !!x);
    if (opt.companyContexts && p.org && (orgCount.get(slug(p.org)) ?? 0) >= 2) ctx.push(ensureContext(ws, p.org, world));
    if (!ctx.length) ctx.push(world);
    const ring = ringFor(r.kind, p.status);
    const prev = byId.get(id);
    if (!prev) {
      const np: WorkspacePerson = {
        id, name: p.name, raw: p.raw, contexts: ctx, closeness: ring.closeness, met: ring.met,
        org: p.org, role: p.role, rank: p.rank, tags: p.tags, lastContact: p.lastContact, connectedOn: p.connectedOn,
        status: p.status, notes: p.notes, url: p.url, sources: [importId],
      };
      ws.people.push(np);
      byId.set(id, np);
      added++;
      continue;
    }
    // Same name seen again: union what we know, keep what was there first.
    prev.contexts = [...new Set([...prev.contexts.filter((c) => c !== world || ctx.includes(c)), ...ctx])];
    prev.org ??= p.org; prev.role ??= p.role; prev.rank ??= p.rank; prev.url ??= p.url; prev.status ??= p.status;
    prev.tags = [...new Set([...prev.tags, ...p.tags])];
    prev.lastContact = [prev.lastContact, p.lastContact].filter(Boolean).sort().pop();
    prev.connectedOn = [prev.connectedOn, p.connectedOn].filter(Boolean).sort()[0];
    prev.closeness = Math.min(prev.closeness, ring.closeness);
    prev.met ||= ring.met;
    prev.sources = [...new Set([...prev.sources, importId])];
    updated++;
  }
  ws.imports.push({ id: importId, kind: r.kind, source: r.source, at: new Date().toISOString(), people: r.people.length });
  return { added, updated, importId };
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
      org: p.org, role: p.role ?? p.rank, lastContact: p.lastContact,
      notes: [p.notes, p.connectedOn ? `Connected ${p.connectedOn}.` : '', p.url ?? ''].filter(Boolean).join(' ') || undefined,
      sources: p.sources.map((s) => label.get(s) ?? 'Import'),
    }));
  const graph: GraphFile = { me: ws.me, contexts: ws.contexts, people, links: ws.links };
  return {
    graph: { data: graph, sample: false },
    imports: ws.imports.map((i) => ({ name: i.source, rows: i.people })),
    networking: { rows: [], sample: false },
    classmates: { rows: [], sample: false },
    encounters: [],
    rules: { aliases: {}, whereMet: [] },
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
      lastContact: p.lastContact ?? null, personId: p.id, inVault: false,
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

/** Local mode only: copy the files-based graph into a browser workspace (stays on this machine). */
export function workspaceFromGraph(g: GraphFile, source: string): Workspace {
  const ws = emptyWorkspace(g.me.name);
  const meId = g.me.id;
  ws.contexts = g.contexts.map((c) => ({ ...c, parent: c.parent === meId ? 'me' : c.parent }));
  const importId = `workspace-${Date.now().toString(36)}`;
  ws.people = g.people.map((p) => ({
    id: p.id, name: p.name, contexts: p.contexts, closeness: p.closeness ?? 3, met: p.met ?? true, org: p.org, role: p.role,
    tags: [], lastContact: p.lastContact, notes: p.notes, sources: [importId],
  }));
  ws.links = g.links.map((l) => ({ ...l, a: l.a === meId ? 'me' : l.a, b: l.b === meId ? 'me' : l.b }));
  ws.imports.push({ id: importId, kind: 'workspace', source, at: new Date().toISOString(), people: ws.people.length });
  return ws;
}
