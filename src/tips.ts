// Guided discovery: one small tip at a time, each shown only when it's useful
// (the sample tour first, then your own map as it grows). Seen tips are remembered per browser.
import type { Network } from './model';
import type { State } from './state';
import { effectiveContexts, type Workspace } from './workspace';

export type TipAction = 'data' | 'sort' | 'scope' | 'attention' | 'backup';

interface Ctx { mode: 'demo' | 'browser' | 'local'; net: Network; ws: Workspace; bridges: number; flagged: number; unplaced: number }

interface Tip {
  id: string;
  when: (c: Ctx) => boolean;
  title?: string;
  body: (c: Ctx) => string;
  actions?: { label: string; do: TipAction }[];
  /** Done as soon as the person clicks a dot. */
  doneOnSelect?: boolean;
  welcome?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const TIPS: Tip[] = [
  {
    id: 'welcome', welcome: true, when: (c) => c.mode === 'demo' && !c.ws.people.length,
    title: 'See the shape of your network',
    body: () => 'This is a sample: one MBA student’s worlds, and the people who connect them. Yours takes about a minute to make, and nothing leaves your device.',
    actions: [{ label: 'Make my map', do: 'data' }],
  },
  {
    id: 'demo-click', doneOnSelect: true, when: (c) => c.mode === 'demo',
    body: () => '<b>Click any dot</b> to see who someone is, how you know them, and the warm path to people you haven’t met.',
  },
  {
    id: 'demo-travel', when: (c) => c.mode === 'demo',
    body: () => '<b>Keep going.</b> Click any connection to travel there, or press ← → to step through them and Enter to go. Your path builds up in the corner; Backspace goes back.',
  },
  {
    id: 'demo-bridges', when: (c) => c.mode === 'demo' && c.bridges > 0,
    body: (c) => `<b>${plural(c.bridges, 'bridge')}</b> connect two of these worlds. They’re listed on the right, and they’re often your best route to an intro.`,
  },
  {
    id: 'demo-attention', when: (c) => c.mode === 'demo' && c.flagged > 0,
    body: (c) => `<b>Amber rings</b> mark ${plural(c.flagged, 'person', 'people')} to get back to: a follow-up is due, a thank-you is owed, or it’s gone quiet.`,
    actions: [{ label: 'Show only them', do: 'attention' }],
  },
  {
    id: 'demo-own', when: (c) => c.mode === 'demo' && !c.ws.people.length,
    body: () => 'That’s the tour. Ready to see your own network?',
    actions: [{ label: 'Make my map', do: 'data' }],
  },
  {
    id: 'own-first', doneOnSelect: true, when: (c) => c.mode === 'browser',
    title: 'This is your network',
    body: (c) => {
      const groups = c.net.contexts.filter((x) => x.depth > 1).length;
      return `${plural(c.net.people.length, 'person', 'people')}${groups ? ` in ${plural(groups, 'group')}` : ''}. Click a dot to see who someone is, or search above.`;
    },
  },
  {
    id: 'own-travel', when: (c) => c.mode === 'browser',
    body: () => '<b>Keep going.</b> Click any connection to travel there, or press ← → to step through them and Enter to go. Your path builds up in the corner; Backspace goes back.',
  },
  {
    id: 'own-second', when: (c) => c.mode === 'browser' && c.ws.imports.length === 1,
    body: () => 'Add a second source, like phone contacts or LinkedIn. People who turn up in two of your worlds become <b>bridges</b>.',
    actions: [{ label: 'Add a source', do: 'data' }],
  },
  {
    id: 'own-sort', when: (c) => c.mode === 'browser' && c.unplaced >= 10,
    body: (c) => `${plural(c.unplaced, 'person is', 'people are')} only in a catch-all group. <b>Sort</b> places each one with a single keystroke.`,
    actions: [{ label: 'Open Sort', do: 'sort' }],
  },
  {
    id: 'own-attention', when: (c) => c.mode === 'browser' && c.flagged > 0,
    body: (c) => `<b>Amber rings</b> mark ${plural(c.flagged, 'person', 'people')} to get back to.`,
    actions: [{ label: 'Show only them', do: 'attention' }],
  },
  {
    id: 'own-scope', when: (c) => c.mode === 'browser',
    body: () => 'Try <b>Scope</b>: the same people on a radar, with the closest at the centre.',
    actions: [{ label: 'Show Scope', do: 'scope' }],
  },
  {
    id: 'own-backup', when: (c) => c.mode === 'browser' && c.ws.imports.length >= 2,
    body: () => 'Your map lives only in this browser. A backup keeps it safe, and moves it to another device.',
    actions: [{ label: 'Download a backup', do: 'backup' }],
  },
];

const KEY = 'ns-tips';
let memory: string[] = [];
function loadSeen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]); } catch { return new Set(memory); }
}
function saveSeen(seen: Set<string>) {
  memory = [...seen];
  try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* this visit only */ }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface TipsEnv {
  mode: Ctx['mode'];
  net: Network;
  ws: Workspace;
  act: (a: TipAction) => void;
}

export function mountTips(host: HTMLElement, env: TipsEnv) {
  const seen = loadSeen();
  const worlds = new Set(env.ws.contexts.filter((c) => c.parent === 'me').map((c) => c.id));
  const ctx: Ctx = {
    mode: env.mode, net: env.net, ws: env.ws,
    bridges: env.net.people.filter((p) => p.worlds.length > 1).length,
    flagged: env.net.people.filter((p) => p.flags.length).length,
    unplaced: env.ws.people.filter((p) => effectiveContexts(env.ws, p).every((c) => worlds.has(c))).length,
  };
  let current: Tip | undefined;
  let lastView = '';

  const next = () => TIPS.find((t) => !seen.has(t.id) && t.when(ctx));
  const done = (id: string) => { seen.add(id); saveSeen(seen); };

  function render() {
    current = env.mode === 'local' || lastView !== 'graph' ? undefined : next();
    host.hidden = !current;
    if (!current) return;
    const t = current;
    const left = TIPS.filter((x) => !seen.has(x.id) && x.when(ctx)).length;
    host.className = `tip${t.welcome ? ' welcome' : ''}`;
    host.innerHTML = `
      ${t.title ? `<h2>${esc(t.title)}</h2>` : ''}
      <p>${t.body(ctx)}</p>
      <div class="tip-actions">
        ${(t.actions ?? []).map((a, i) => `<button class="${i === 0 ? 'primary' : ''}" data-tip-do="${a.do}">${esc(a.label)}</button>`).join('')}
        <button data-tip-ok>${t.welcome ? 'Explore the sample' : t.actions?.length ? 'Not now' : 'Got it'}</button>
        ${!t.welcome && left > 1 ? '<button class="quiet" data-tip-skip>Skip tips</button>' : ''}
      </div>`;
  }

  host.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!b || !current) return;
    const id = current.id;
    if (b.dataset.tipSkip !== undefined) {
      // Skipping the tour still leaves the "make your own" prompts for later.
      TIPS.filter((t) => !t.actions?.some((a) => a.do === 'data')).forEach((t) => seen.add(t.id));
      saveSeen(seen);
    } else done(id);
    if (b.dataset.tipDo) env.act(b.dataset.tipDo as TipAction);
    render();
  });

  return {
    update(s: State) {
      if (current?.doneOnSelect && s.selected) done(current.id);
      lastView = s.view;
      render();
    },
  };
}
