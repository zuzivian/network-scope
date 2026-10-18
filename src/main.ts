import './style.css';
import { browserStore } from './browser-sort';
import { mountDataView, type Mode } from './dataview';
import { demoSources } from './demo';
import { mountGraph, type GraphView } from './graph';
import { hasLocalData, localContacts, localSortStore, localSources } from './local-data';
import { buildNetwork, type Sources } from './model';
import { renderPanel } from './panel';
import { mountScope, type Scope } from './scope';
import { mountSort, type SortView } from './sort';
import { createStore, type View } from './state';
import { loadWorkspace, toSources, workspaceContacts } from './workspace';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const VIEWS: View[] = ['graph', 'scope', 'sort', 'data'];

/** Reload into a view ("graph", or "graph&demo" to keep demo mode). Used after data changes. */
function reload(view = 'graph') {
  const [v, ...flags] = view.split('&');
  const u = new URL(location.pathname, location.origin);
  if (v !== 'graph') u.searchParams.set('view', v);
  for (const f of flags) u.searchParams.set(f, '1');
  location.href = u.toString();
}

async function boot() {
  // Which network to show: the demo, Nat's local files (dev only), or this browser's workspace.
  let pref: string | null = null;
  try { pref = localStorage.getItem('ns-source'); } catch { /* storage blocked */ }
  const ws = await loadWorkspace();
  const mode: Mode = params.has('demo') ? 'demo' : hasLocalData && pref !== 'browser' ? 'local' : 'browser';
  const sources: Sources = mode === 'demo' ? demoSources() : mode === 'local' ? localSources()! : toSources(ws);
  const empty = mode === 'browser' && ws.people.length === 0;

  const net = buildNetwork(sources);
  const qView = params.get('view') as View | null;
  const initialView: View = empty ? 'data' : qView && VIEWS.includes(qView) ? qView : 'graph';
  const store = createStore({ selected: null, hidden: new Set<string>(), query: '', attentionOnly: false, view: initialView });
  const select = (id: string | null) => store.set({ selected: id });
  const panel = $('panel');

  // Mode badge
  const badge = $('sample-badge');
  badge.hidden = false;
  badge.textContent = mode === 'demo' ? 'Sample data' : mode === 'local' ? 'Local files' : 'Private · this browser';
  badge.className = `badge ${mode}`;
  document.body.dataset.mode = mode;
  document.body.classList.toggle('empty', empty);

  // Graph-dependent views only exist once there's a network to draw.
  const graph: GraphView | null = empty ? null : mountGraph($('graph'), net, select);
  let scope: Scope | null = null;
  let sort: SortView | null = null;
  const sortContacts = mode === 'local' ? localContacts : mode === 'browser' ? workspaceContacts(ws) : [];
  const ensureSort = () => {
    if (sort || empty || mode === 'demo') return sort;
    sort = mode === 'local'
      ? mountSort($('sort'), () => panel, net, sortContacts, localSortStore())
      : mountSort($('sort'), () => panel, net, sortContacts, browserStore(ws, () => reload('graph')));
    return sort;
  };

  let dirty = false;
  mountDataView($('data'), {
    mode, ws, hasLocalData,
    localGraph: () => localSources()?.graph.data ?? null,
    markDirty: () => {
      dirty = true;
      // First import into an empty workspace: the other views open now (each click reloads with the new data).
      if (empty) document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => { b.disabled = false; });
    },
    reload,
  });

  // World filters
  const chips = $('circles');
  chips.innerHTML = net.worlds.map((w) => {
    const n = net.people.filter((p) => p.worlds.includes(w.id)).length;
    return `<button class="chip-btn" data-world="${w.id}" aria-pressed="true">${w.name}<span>${n}</span></button>`;
  }).join('');
  chips.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-world]');
    if (!b) return;
    const hidden = new Set(store.get().hidden);
    const id = b.dataset.world!;
    hidden.has(id) ? hidden.delete(id) : hidden.add(id);
    store.set({ hidden });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.view as View;
      // Data changed in this session: rebuild the network before showing it.
      if (dirty && v !== 'data') return reload(v);
      if (empty && v !== 'data') return;
      store.set({ view: v });
    }));
  $<HTMLInputElement>('search').addEventListener('input', (e) => store.set({ query: (e.target as HTMLInputElement).value }));
  $('attention').addEventListener('click', () => store.set({ attentionOnly: !store.get().attentionOnly }));
  $('reset').addEventListener('click', () => (store.get().view === 'graph' ? graph?.resetView() : scope?.resetView()));

  panel.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-select]');
    if (b) select(b.dataset.select || null);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') select(null); });

  // Sweep (scope view only)
  const motionBtn = $('motion');
  let motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  motionBtn.addEventListener('click', () => { motion = !motion; motionBtn.setAttribute('aria-pressed', String(motion)); scope?.setMotion(motion); });
  motionBtn.setAttribute('aria-pressed', String(motion));

  store.subscribe((s) => {
    const v = s.view;
    $('graph').hidden = v !== 'graph';
    $('scope').hidden = v !== 'scope';
    $('sort').hidden = v !== 'sort';
    $('data').hidden = v !== 'data';
    const url = new URL(location.href);
    if (v === 'graph') url.searchParams.delete('view'); else url.searchParams.set('view', v);
    history.replaceState(null, '', url);
    document.body.dataset.view = v;
    motionBtn.hidden = v !== 'scope';
    if (v === 'scope' && !scope && !empty) { scope = mountScope($('scope'), net, select); scope.setMotion(motion); }
    scope?.setMotion(v === 'scope' && motion);
    graph?.update(s);
    scope?.update(s);
    const sv = v === 'sort' ? ensureSort() : sort;
    if (v === 'sort' && sv) sv.show(); else { sort?.hide(); if (!empty) renderPanel(panel, net, s); }
    chips.querySelectorAll<HTMLButtonElement>('[data-world]').forEach((b) => b.setAttribute('aria-pressed', String(!s.hidden.has(b.dataset.world!))));
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.view === v));
      b.disabled = empty && b.dataset.view !== 'data' || (mode === 'demo' && b.dataset.view === 'sort');
    });
    $('attention').setAttribute('aria-pressed', String(s.attentionOnly));
  });
}

// Theme: follows the system until toggled; the choice is remembered per browser.
const root = document.documentElement;
try { const t = localStorage.getItem('theme'); if (t) root.dataset.theme = t; } catch { /* ignore */ }
$('theme').addEventListener('click', () => {
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', root.dataset.theme); } catch { /* ignore */ }
});

boot();
