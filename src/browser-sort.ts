// Sort screen backed by the browser workspace instead of the local dev server.
import type { Context } from './model';
import type { SortStore } from './sort';
import { effectiveContexts, saveWorkspace, type Workspace } from './workspace';

export function browserStore(ws: Workspace, reload: () => void): SortStore {
  return {
    queues: [
      { id: 'unplaced', label: 'Not placed', hint: 'Only in an import bucket (e.g. "Contacts"). Say where you know them from' },
      { id: 'suggested', label: 'Suggested by tags', hint: 'A tag in their name or company matched one of your tag rules. Batch mode confirms a group at once' },
      { id: 'placed', label: 'Placed', hint: 'Already in a group from the import. Review only if you want to' },
    ],
    slots(_queue, contexts: Context[]) {
      // The nine contexts with the most people, so the keys follow your own structure.
      const count = new Map<string, number>();
      for (const p of ws.people) for (const c of effectiveContexts(ws, p)) count.set(c, (count.get(c) ?? 0) + 1);
      return contexts.filter((c) => c.id !== ws.me.id)
        .sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0) || a.depth - b.depth)
        .slice(0, 9).map((c) => c.id);
    },
    async load() {
      return { contexts: [], decisions: ws.decisions };
    },
    async save(a) {
      ws.decisions = a.decisions;
      for (const c of a.contexts) if (!ws.contexts.some((x) => x.id === c.id)) ws.contexts.push(c);
      await saveWorkspace(ws);
      return true;
    },
    async apply(a) {
      await this.save(a);
      reload();
      return { ok: true, summary: 'graph rebuilt', appliedAt: new Date().toISOString() };
    },
    applyHint: 'Rebuilds the graph from your decisions. Everything stays in this browser.',
  };
}
