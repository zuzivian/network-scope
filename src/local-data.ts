// Local mode: reads your own files from data/ (gitignored). The public build replaces this
// module with local-data.stub.ts (see vite.config.ts), so none of it can reach the web.
import type { GraphFile, Sources } from './model';
import type { Assignments, Contact, QueueDef, SortStore } from './sort';

// Real files (gitignored) win over the fictional fixtures, per source.
// assignments.json is excluded: the Sort screen reads and writes it through the dev server.
const files = import.meta.glob<unknown>(['../data/**/*.json', '!../data/assignments.json'], { eager: true, import: 'default' });

// WhatsApp/Contacts roster, plus LinkedIn connections that aren't on it.
export const localContacts = [
  ...((files['../data/contacts.json'] ?? []) as Contact[]),
  ...((files['../data/linkedin-contacts.json'] ?? []) as Contact[]),
];
export const hasLocalData = !!files['../data/graph.json'];

function rows(real: string, fixture: string) {
  const r = files[`../data/${real}`];
  if (Array.isArray(r)) return { rows: r as Record<string, unknown>[], sample: false };
  return { rows: (files[`../data/fixtures/${fixture}`] ?? []) as Record<string, unknown>[], sample: true };
}

/**
 * Lay an imported graph (e.g. from WhatsApp) over the vault graph.
 * Same id = same person: contexts are unioned and vault fields win.
 */
function overlay(base: GraphFile, extra: GraphFile, source: string): GraphFile {
  const contexts = [...base.contexts];
  const ctxIds = new Set(contexts.map((c) => c.id));
  for (const c of extra.contexts) if (!ctxIds.has(c.id)) { contexts.push(c); ctxIds.add(c.id); }

  const people = new Map(base.people.map((p) => [p.id, { ...p, sources: p.sources ?? ['Binny vault'] }]));
  for (const p of extra.people) {
    const prev = people.get(p.id);
    if (!prev) { people.set(p.id, { ...p, sources: [source] }); continue; }
    people.set(p.id, {
      ...p, ...prev,
      contexts: [...new Set([...prev.contexts, ...p.contexts])],
      sources: [...new Set([...(prev.sources ?? []), source])],
    });
  }
  return { me: base.me, contexts, people: [...people.values()], links: [...base.links, ...extra.links] };
}

export function localSources(): Sources | null {
  if (!hasLocalData) return null;
  const real = files['../data/graph.json'] as GraphFile | undefined;
  const imported = files['../data/imported.json'] as GraphFile | undefined;
  const linkedin = files['../data/linkedin.json'] as GraphFile | undefined;
  let data = real;
  if (data && imported) data = overlay(data, imported, 'WhatsApp');
  if (data && linkedin) data = overlay(data, linkedin, 'LinkedIn');
  const graph = data
    ? { data, sample: false, label: 'Binny vault' }
    : { data: files['../data/fixtures/graph.json'] as GraphFile, sample: true };
  const tagMap = (files['../data/tag-map.json'] ?? {}) as { aliases?: Record<string, string>; whereMet?: { match: string; context: string }[] };
  return {
    graph,
    encounters: real ? ((files['../data/notion/encounters.json'] ?? []) as Record<string, unknown>[]) : [],
    rules: { aliases: tagMap.aliases ?? {}, whereMet: tagMap.whereMet ?? [] },
    imports: real ? [
      ...(imported ? [{ name: 'WhatsApp contacts + groups', rows: imported.people.length }] : []),
      ...(linkedin ? [{ name: 'LinkedIn connections', rows: linkedin.people.length }] : []),
    ] : [],
    networking: rows('notion/networking-tracker.json', 'networking-tracker.json'),
    classmates: rows('notion/classmate-network.json', 'classmate-network.json'),
  };
}

// ---------- Sort screen config (data/sort-config.json, gitignored: queue names and context ids are personal) ----------

const sortConfig = (files['../data/sort-config.json'] ?? {}) as { queues?: QueueDef[]; slots?: Record<string, string[]> };
const QUEUES: QueueDef[] = sortConfig.queues ?? [
  { id: 'placed', label: 'Placed', hint: 'Placed by the importers' },
  { id: 'linkedin', label: 'LinkedIn only', hint: 'LinkedIn connections not in your phone' },
];
const SLOTS: Record<string, string[]> = sortConfig.slots ?? {};

/** Local mode: decisions go to data/assignments.json and the WhatsApp + LinkedIn importers apply them. */
export function localSortStore(): SortStore {
  const post = (a: Assignments) => fetch('/api/assignments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) });
  return {
    queues: QUEUES,
    slots: (q, contexts) => SLOTS[q] ?? SLOTS.placed ?? contexts.filter((c) => c.depth === 1).map((c) => c.id),
    load: () => fetch('/api/assignments').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    save: (a) => post(a).then((r) => r.ok).catch(() => false),
    async apply(a) {
      await post(a);
      const r = await fetch('/api/reimport', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      // The import rewrites data/*.json; Vite reloads the page with the new graph.
      return { ok: r.ok, summary: r.ok ? j.summary ?? '' : j.error ?? String(r.status), appliedAt: j.appliedAt };
    },
    applyHint: 'Reruns the WhatsApp and LinkedIn imports with your decisions. Decisions win over contact-name tags and companies.',
  };
}
