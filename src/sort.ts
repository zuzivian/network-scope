// Sort screen: place every contact in a context, one at a time, from the keyboard.
// Decisions are saved to data/assignments.json through the dev server and applied
// by rerunning scripts/import_whatsapp.py ("Apply to graph").
import type { Context, Network } from './model';

export interface Contact {
  key: string;
  name: string;
  raw: string;
  rank: string | null;
  tags: string[];
  suggested: string[];
  lastContact: string | null;
  personId: string;
  inVault: boolean;
  queue: Queue;
  region?: string;
  notion?: string | null;
}

type Queue = string;

interface Decision { contexts?: string[]; exclude?: boolean; skip?: boolean; at: string }
export interface Assignments { contexts: { id: string; name: string; parent: string }[]; decisions: Record<string, Decision>; appliedAt?: string }
export interface QueueDef { id: Queue; label: string; hint: string }

/** Where decisions live: the local dev server (Nat's files) or this browser's workspace. */
export interface SortStore {
  queues: QueueDef[];
  slots(queue: Queue, contexts: Context[]): string[];
  load(): Promise<Assignments | null>;
  save(a: Assignments): Promise<boolean>;
  apply(a: Assignments): Promise<{ ok: boolean; summary: string; appliedAt?: string }>;
  applyHint: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export interface SortView { show(): void; hide(): void }

export function mountSort(host: HTMLElement, panel: () => HTMLElement, net: Network, contacts: Contact[], store: SortStore): SortView {
  let data: Assignments = { contexts: [], decisions: {} };
  let queue: Queue = store.queues[0]?.id ?? 'placed';
  let idx = 0;
  let pending: string[] = [];
  let lastSearchPick: string | null = null;
  let mode: 'search' | 'parent' = 'search';
  let newName = '';
  let active = false;
  let batch = false;
  const unticked = new Set<string>();
  let saving: number | undefined;
  let saveState = 'loading…';
  let appliedAt = 0;
  const history: string[] = [];

  const contexts = (): Context[] => {
    const extra = data.contexts.filter((c) => !net.contexts.some((x) => x.id === c.id))
      .map((c) => ({ ...c, world: worldOf(c.parent), depth: 2, members: 0 }));
    return [...net.contexts, ...extra];
  };
  const byId = () => new Map(contexts().map((c) => [c.id, c]));
  function worldOf(id: string): string {
    const m = new Map([...net.contexts, ...data.contexts].map((c) => [c.id, c] as const));
    let cur = m.get(id);
    while (cur && cur.parent !== net.me.id) cur = m.get(cur.parent);
    return cur?.id ?? id;
  }
  const path = (id: string) => {
    const m = byId();
    const parts: string[] = [];
    for (let c = m.get(id); c; c = m.get(c.parent)) parts.unshift(c.name);
    return parts.join(' › ');
  };
  const nameOf = (id: string) => byId().get(id)?.name ?? id;

  const inQueue = (q: Queue) => contacts.filter((c) => c.queue === q);
  const decided = (c: Contact) => { const d = data.decisions[c.key]; return !!d && !d.skip; };
  const list = () => {
    const all = inQueue(queue);
    // Undecided first, then skipped, then decided (for review).
    const rank = (c: Contact) => (decided(c) ? 2 : data.decisions[c.key]?.skip ? 1 : 0);
    return [...all].sort((a, b) => rank(a) - rank(b) || (b.lastContact ?? '').localeCompare(a.lastContact ?? '') || a.name.localeCompare(b.name));
  };
  const current = () => list()[idx];
  const slots = () => {
    const s = [...store.slots(queue, contexts())].slice(0, 9);
    if (lastSearchPick && !s.includes(lastSearchPick)) s[8] = lastSearchPick;
    return s.filter((id) => byId().has(id));
  };

  function save() {
    clearTimeout(saving);
    saveState = 'saving…';
    renderSide();
    saving = window.setTimeout(async () => {
      try {
        saveState = (await store.save(data)) ? 'saved' : 'save failed';
      } catch {
        saveState = 'save failed: is the dev server running?';
      }
      renderSide();
    }, 350);
  }

  function decide(d: Omit<Decision, 'at'>) {
    const c = current();
    if (!c) return;
    data.decisions[c.key] = { ...d, at: new Date().toISOString() };
    history.push(c.key);
    pending = [];
    // Stay on the same index: the decided contact sorts to the back of the queue.
    const l = list();
    idx = Math.min(idx, Math.max(0, l.filter((x) => !decided(x)).length - 1));
    if (decided(l[idx]) && l.some((x) => !decided(x))) idx = l.findIndex((x) => !decided(x));
    save();
    render();
  }

  function undo() {
    const key = history.pop();
    if (!key) return;
    delete data.decisions[key];
    const c = contacts.find((x) => x.key === key)!;
    queue = c.queue;
    idx = list().findIndex((x) => x.key === key);
    save();
    render();
  }

  function pick(id: string, keepGoing: boolean) {
    if (keepGoing) {
      pending = pending.includes(id) ? pending.filter((x) => x !== id) : [...pending, id];
      render();
    } else {
      decide({ contexts: [...new Set([...pending, id])] });
    }
  }

  function accept() {
    const c = current();
    if (!c) return;
    if (pending.length) return decide({ contexts: pending });
    if (c.suggested.length) return decide({ contexts: c.suggested });
  }

  function results(q: string): { id: string; label: string; sub: string; create?: boolean }[] {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const scored: { id: string; label: string; sub: string; create?: boolean }[] = contexts()
      .map((c) => ({ c, p: path(c.id), i: c.name.toLowerCase().indexOf(s) }))
      .filter((x) => x.i >= 0 || x.p.toLowerCase().includes(s))
      .sort((a, b) => (a.i < 0 ? 99 : a.i) - (b.i < 0 ? 99 : b.i) || a.c.name.length - b.c.name.length)
      .slice(0, 7)
      .map((x) => ({ id: x.c.id, label: x.c.name, sub: x.p }));
    if (mode === 'search' && !contexts().some((c) => c.name.toLowerCase() === s)) {
      scored.push({ id: '', label: `Create “${q.trim()}”`, sub: 'New context, then pick where it goes', create: true });
    }
    return scored;
  }

  // ---------- Render ----------

  function render() {
    if (!active) return;
    const l = list();
    const c = l[idx];
    const counts = store.queues.map((q) => {
      const all = inQueue(q.id);
      return { ...q, total: all.length, left: all.filter((x) => !decided(x)).length };
    });
    const qc = counts.find((x) => x.id === queue)!;
    const done = qc.total - qc.left;
    const m = byId();
    const tagChips = c ? c.tags.map((t) => `<span class="chip ${c.suggested.length ? '' : 'muted'}">${esc(t)}</span>`).join('') : '';
    const d = c ? data.decisions[c.key] : undefined;

    host.innerHTML = `
      <div class="sort">
        <nav class="queues" role="tablist">${counts.map((q) => `<button role="tab" aria-selected="${q.id === queue}" data-queue="${q.id}" title="${esc(q.hint)}">
          ${q.label}<span>${q.left ? `${q.left} left` : q.total ? 'done' : 'none'}</span></button>`).join('')}</nav>
        <div class="progress" title="${done} of ${qc.total} decided"><i style="width:${qc.total ? (done / qc.total) * 100 : 0}%"></i></div>
        <p class="queue-hint">${esc(qc.hint)} · ${done} of ${qc.total} decided
          <button class="mode" data-batch aria-pressed="${batch}"><kbd>B</kbd> ${batch ? 'One at a time' : 'Batch mode'}</button></p>
        ${batch ? renderBatch() : c ? `
        <article class="card">
          <p class="eyebrow">${idx + 1} of ${l.length}${d ? ` · ${d.exclude ? 'marked not in network' : d.skip ? 'skipped' : 'decided'}` : ''}</p>
          <h2>${esc(c.name)}</h2>
          <p class="raw">Saved as “${esc(c.raw)}”</p>
          <div class="chips">${c.rank ? `<span class="chip rank">${esc(c.rank)}</span>` : ''}${tagChips}
            ${c.inVault ? '<span class="chip vault">In your vault</span>' : ''}</div>
          <div class="suggest">${c.suggested.length
            ? `<button class="accept" data-accept>Enter · ${esc(c.suggested.map((id) => m.get(id)?.name ?? id).join(' + '))}</button>`
            : '<span class="fine">No suggestion</span>'}
            ${d?.contexts ? `<span class="fine">Now: ${esc(d.contexts.map(nameOf).join(' + '))}</span>` : ''}</div>
          ${pending.length ? `<p class="pending">Adding: ${pending.map((id) => `<b>${esc(nameOf(id))}</b>`).join(' + ')} · Enter to save</p>` : ''}
          <div class="slots">${slots().map((id, i) => `<button class="slot${pending.includes(id) ? ' on' : ''}" data-slot="${id}">
            <kbd>${i + 1}</kbd><span>${esc(nameOf(id))}</span><small>${esc(path(id).split(' › ').slice(0, -1).join(' › ') || 'World')}</small></button>`).join('')}</div>
          <div class="search-wrap">
            <input id="ctx-search" type="search" autocomplete="off" placeholder="${mode === 'parent' ? `Where does “${esc(newName)}” go? Type a parent…` : 'Type / to search every context'}" />
            <ul id="ctx-results" class="results"></ul>
          </div>
          <div class="actions">
            <button data-act="exclude"><kbd>X</kbd> Not in my network</button>
            <button data-act="skip"><kbd>S</kbd> Skip</button>
            <button data-act="undo"><kbd>U</kbd> Undo</button>
            <button data-act="prev"><kbd>←</kbd></button><button data-act="next"><kbd>→</kbd></button>
          </div>
        </article>` : `<article class="card empty"><h2>Queue done</h2><p class="fine">Pick another queue, or press Apply to graph.</p></article>`}
      </div>`;
    renderSide();
  }

  function renderBatch(): string {
    const todo = list().filter((x) => !decided(x));
    const groups = new Map<string, Contact[]>();
    for (const x of todo) {
      const k = x.suggested.join('+');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(x);
    }
    const ordered = [...groups.entries()].sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1) || b[1].length - a[1].length);
    if (!ordered.length) return '<article class="card empty"><h2>Queue done</h2></article>';
    return ordered.map(([k, xs]) => {
      const label = k ? k.split('+').map(nameOf).join(' + ') : 'No suggestion';
      const n = xs.filter((x) => !unticked.has(x.key)).length;
      return `<section class="batch">
        <header><h3>${esc(label)} <span class="count">${xs.length}</span></h3>
          ${k ? `<button class="accept" data-confirm="${esc(k)}" ${n ? '' : 'disabled'}>Confirm ${n}</button>` : '<span class="fine">Switch to one at a time for these</span>'}</header>
        <ul>${xs.slice(0, 200).map((x) => `<li><label><input type="checkbox" data-tick="${x.key}" ${!k ? 'disabled' : unticked.has(x.key) ? '' : 'checked'} />
          <b>${esc(x.name)}</b><small>${esc(x.raw)}${x.notion ? ' · in Notion' : ''}</small></label>
          <button class="mini" data-exclude="${x.key}" title="Not in my network">X</button></li>`).join('')}</ul>
      </section>`;
    }).join('');
  }

  function confirmGroup(k: string) {
    const xs = list().filter((x) => !decided(x) && x.suggested.join('+') === k && !unticked.has(x.key));
    const at = new Date().toISOString();
    for (const x of xs) { data.decisions[x.key] = { contexts: x.suggested, at }; history.push(x.key); }
    save();
    render();
  }

  function renderSide() {
    if (!active) return;
    const el = panel();
    const total = Object.values(data.decisions).filter((d) => !d.skip).length;
    const since = Object.values(data.decisions).filter((d) => !d.skip && Date.parse(d.at) > appliedAt).length;
    const recent = history.slice(-8).reverse().map((k) => contacts.find((c) => c.key === k)!).filter(Boolean);
    el.innerHTML = `
      <header class="panel-head"><p class="eyebrow">Sorting · ${esc(saveState)}</p>
        <div class="stats two"><div><b>${total}</b><span>decided</span></div><div><b>${contacts.length - total}</b><span>to go</span></div></div></header>
      <button class="apply" data-apply ${since || !appliedAt ? '' : 'disabled'}>Apply to graph${since ? ` · ${since} new` : ''}</button>
      <p class="fine">${esc(store.applyHint)}</p>
      <section class="block"><h3>Keys</h3><dl class="keys">
        <div><dt>1–9</dt><dd>Place and go to the next contact</dd></div>
        <div><dt>⇧ 1–9</dt><dd>Add a context, Enter to save several</dd></div>
        <div><dt>Enter</dt><dd>Accept the suggestion</dd></div>
        <div><dt>/</dt><dd>Search all contexts, or create one</dd></div>
        <div><dt>X · S · U</dt><dd>Not in network · skip · undo</dd></div>
        <div><dt>← →</dt><dd>Move without deciding</dd></div>
        <div><dt>B</dt><dd>Batch mode: confirm a whole group at once</dd></div>
      </dl></section>
      ${recent.length ? `<section class="block"><h3>Just decided</h3><ul class="people">${recent.map((c) => {
        const d = data.decisions[c.key];
        const what = !d ? 'undone' : d.exclude ? 'not in network' : d.skip ? 'skipped' : (d.contexts ?? []).map(nameOf).join(' + ');
        return `<li><button class="person-row" data-goto="${c.key}"><span class="dot"></span><span class="who"><b>${esc(c.name)}</b><small>${esc(what)}</small></span><span class="meta"></span></button></li>`;
      }).join('')}</ul></section>` : ''}`;
  }

  function showResults() {
    const input = host.querySelector<HTMLInputElement>('#ctx-search');
    const ul = host.querySelector<HTMLUListElement>('#ctx-results');
    if (!input || !ul) return;
    const r = results(input.value);
    ul.innerHTML = r.map((x, i) => `<li><button class="${i === 0 ? 'top' : ''}${x.create ? ' create' : ''}" data-result="${x.id}" data-create="${x.create ? '1' : ''}">
      <b>${esc(x.label)}</b><small>${esc(x.sub)}</small></button></li>`).join('');
  }

  function chooseResult(id: string, create: boolean, shift: boolean) {
    const input = host.querySelector<HTMLInputElement>('#ctx-search')!;
    if (create) {
      newName = input.value.trim();
      mode = 'parent';
      render();
      host.querySelector<HTMLInputElement>('#ctx-search')?.focus();
      return;
    }
    if (mode === 'parent') {
      let cid = slug(newName);
      while (byId().has(cid)) cid += '-x';
      data.contexts.push({ id: cid, name: newName, parent: id });
      mode = 'search';
      lastSearchPick = cid;
      return pick(cid, shift);
    }
    lastSearchPick = id;
    pick(id, shift);
  }

  // ---------- Events ----------

  host.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-batch]')) { batch = !batch; return render(); }
    const conf = t.closest<HTMLElement>('[data-confirm]');
    if (conf) return confirmGroup(conf.dataset.confirm!);
    const ex = t.closest<HTMLElement>('[data-exclude]');
    if (ex) { data.decisions[ex.dataset.exclude!] = { exclude: true, at: new Date().toISOString() }; history.push(ex.dataset.exclude!); save(); return render(); }
    const tick = t.closest<HTMLInputElement>('[data-tick]');
    if (tick) { tick.checked ? unticked.delete(tick.dataset.tick!) : unticked.add(tick.dataset.tick!); return render(); }
    const q = t.closest<HTMLElement>('[data-queue]');
    if (q) { queue = q.dataset.queue as Queue; idx = 0; pending = []; return render(); }
    const s = t.closest<HTMLElement>('[data-slot]');
    if (s) return pick(s.dataset.slot!, (e as MouseEvent).shiftKey);
    if (t.closest('[data-accept]')) return accept();
    const r = t.closest<HTMLElement>('[data-result]');
    if (r) return chooseResult(r.dataset.result!, r.dataset.create === '1', (e as MouseEvent).shiftKey);
    const a = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (a === 'exclude') decide({ exclude: true });
    if (a === 'skip') decide({ skip: true });
    if (a === 'undo') undo();
    if (a === 'prev') { idx = Math.max(0, idx - 1); pending = []; render(); }
    if (a === 'next') { idx = Math.min(list().length - 1, idx + 1); pending = []; render(); }
  });
  host.addEventListener('input', (e) => { if ((e.target as HTMLElement).id === 'ctx-search') showResults(); });

  document.addEventListener('click', async (e) => {
    if (!active) return;
    const t = e.target as HTMLElement;
    const g = t.closest<HTMLElement>('[data-goto]');
    if (g) {
      const c = contacts.find((x) => x.key === g.dataset.goto)!;
      queue = c.queue; idx = list().findIndex((x) => x.key === c.key); pending = [];
      return render();
    }
    if (t.closest('[data-apply]')) {
      const btn = t.closest<HTMLButtonElement>('[data-apply]')!;
      btn.disabled = true;
      btn.textContent = 'Applying…';
      clearTimeout(saving);
      const r = await store.apply(data);
      saveState = r.ok ? `applied · ${r.summary}` : `apply failed: ${r.summary}`;
      if (r.ok && r.appliedAt) { data.appliedAt = r.appliedAt; appliedAt = Date.parse(r.appliedAt); }
      renderSide();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!active) return;
    const input = host.querySelector<HTMLInputElement>('#ctx-search');
    const inSearch = document.activeElement === input;
    if (inSearch) {
      if (e.key === 'Escape') { input!.value = ''; mode = 'search'; input!.blur(); showResults(); render(); }
      if (e.key === 'Enter') {
        e.preventDefault();
        const top = host.querySelector<HTMLElement>('#ctx-results [data-result]');
        if (top) chooseResult(top.dataset.result!, top.dataset.create === '1', e.shiftKey);
      }
      return;
    }
    if ((e.target as HTMLElement).closest?.('input, textarea')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.toLowerCase() === 'b') { batch = !batch; return render(); }
    if (batch) { if (e.key.toLowerCase() === 'u') undo(); return; }
    const digit = e.code.match(/^Digit([1-9])$/)?.[1];
    if (digit) {
      const id = slots()[Number(digit) - 1];
      if (id) { e.preventDefault(); pick(id, e.shiftKey); }
      return;
    }
    const k = e.key.toLowerCase();
    if (e.key === 'Enter') { e.preventDefault(); accept(); }
    else if (k === '/' || e.code === 'Slash') { e.preventDefault(); input?.focus(); }
    else if (k === 'x') decide({ exclude: true });
    else if (k === 's') decide({ skip: true });
    else if (k === 'u') undo();
    else if (e.key === 'ArrowLeft') { idx = Math.max(0, idx - 1); pending = []; render(); }
    else if (e.key === 'ArrowRight') { idx = Math.min(list().length - 1, idx + 1); pending = []; render(); }
  });

  store.load().then((j) => {
    if (j) { data = { contexts: j.contexts ?? [], decisions: j.decisions ?? {}, appliedAt: j.appliedAt }; appliedAt = j.appliedAt ? Date.parse(j.appliedAt) : 0; saveState = 'saved'; }
    else saveState = 'not saving: run the dev server (npm run dev)';
    queue = (store.queues.find((q) => inQueue(q.id).some((c) => !decided(c)))?.id) ?? queue;
    render();
  }).catch(() => { saveState = 'not saving: run the dev server (npm run dev)'; render(); });

  return {
    show() { active = true; render(); },
    hide() { active = false; },
  };
}
