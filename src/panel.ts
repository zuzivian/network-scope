import { introPath, introText, isSocial, LINK_LABEL, RINGS, type Context, type Network, type Node } from './model';
import type { State } from './state';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function fmtDate(d?: string) {
  if (!d) return 'none recorded';
  return new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function renderPanel(el: HTMLElement, net: Network, s: State) {
  const ctx = new Map(net.contexts.map((c) => [c.id, c]));
  const people = new Map(net.people.map((p) => [p.id, p]));
  const worldName = (id: string) => ctx.get(id)?.name ?? id;

  const dot = (n: Node) =>
    `<span class="dot ring-${n.ring}${n.met ? '' : ' never'}"></span>`;
  const row = (n: Node, meta: string) => `<li><button class="person-row" data-select="${n.id}">
    ${dot(n)}<span class="who"><b>${esc(n.name)}</b><small>${esc(n.org ?? n.role ?? worldName(n.world))}</small></span>
    <span class="meta${meta.length > 16 ? ' wide' : ''}">${esc(meta)}</span></button></li>`;
  const ctxRow = (c: Context, meta: string) => `<li><button class="person-row" data-select="${c.id}">
    <span class="diamond${c.depth === 1 ? ' world' : ''}"></span><span class="who"><b>${esc(c.name)}</b>
    <small>${esc(c.years ?? c.role ?? '')}</small></span><span class="meta">${esc(meta)}</span></button></li>`;
  const path = (c: Context) => {
    const parts: string[] = [];
    for (let cur: Context | undefined = c; cur; cur = ctx.get(cur.parent)) parts.unshift(cur.name);
    return parts.join(' › ');
  };

  function readout() {
    const visible = net.people.filter((p) => !p.worlds.every((w) => s.hidden.has(w)));
    const bridges = visible.filter((p) => p.worlds.length > 1).sort((a, b) => b.worlds.length - a.worlds.length || a.ring - b.ring);
    const worldCounts = net.worlds.map((w) => ({ w, n: visible.filter((p) => p.worlds.includes(w.id)).length })).sort((a, b) => b.n - a.n);
    const max = Math.max(1, ...worldCounts.map((x) => x.n));
    const src = net.sources.filter((x) => x.rows > 0 || x.sample).map((x) => {
      const tag = x.skipped ? '<span class="tag off">not connected</span>'
        : x.sample ? '<span class="tag sample">sample</span>' : `<span class="tag live">${x.rows} rows</span>`;
      return `<li><span>${esc(x.name)}</span>${tag}</li>`;
    }).join('');

    return `
      <header class="panel-head"><p class="eyebrow">Readout · ${esc(fmtDate(net.today))}</p>
        <div class="stats">
          <div><b>${visible.length}</b><span>people</span></div>
          <div><b>${bridges.length}</b><span>bridges</span></div>
          <div><b>${net.worlds.filter((w) => !s.hidden.has(w.id)).length}</b><span>worlds</span></div>
        </div></header>
      <section class="block"><h3>By world</h3>
        <ul class="rings">${worldCounts.map(({ w, n }) => `<li><button class="world-row" data-select="${w.id}"><span class="rl">${esc(w.name)}</span>
          <span class="rbar"><i style="width:${(n / max) * 100}%"></i></span><span class="rn">${n}</span></button></li>`).join('')}</ul>
      </section>
      ${bridges.length ? `<section class="block"><h3>Bridges <span class="count">${bridges.length}</span></h3>
        <p class="fine lead">People who connect two or more of your worlds.</p>
        <ul class="people">${bridges.slice(0, 8).map((n) => row(n, n.worlds.map(worldName).join(' · '))).join('')}</ul></section>` : ''}
      <footer class="sources"><h3>Sources</h3><ul>${src}</ul>
        ${net.excluded ? `<p class="fine">${net.excluded} closed contact${net.excluded > 1 ? 's' : ''} hidden.</p>` : ''}</footer>`;
  }

  function personDossier(n: Node) {
    const social = net.links.filter((l) => isSocial(l) && (l.a === n.id || l.b === n.id));
    const conns = social.map((l) => {
      const other = l.a === n.id ? l.b : l.a;
      return other === net.me.id ? null : { p: people.get(other)!, kind: LINK_LABEL[l.kind], label: l.label };
    }).filter((x): x is NonNullable<typeof x> => !!x && !!x.p);
    const chips = [...n.worlds.map(worldName), RINGS[n.ring - 1].label, n.tier ? `Tier ${n.tier}` : '', n.status ?? '']
      .filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join('');
    const fact = (k: string, v?: string, cls = '') => (v ? `<div class="fact ${cls}"><dt>${k}</dt><dd>${esc(v)}</dd></div>` : '');
    const chain = n.met ? null : introPath(net, n.id);

    return `
      <header class="panel-head dossier-head">
        <button class="back" data-select="">← Readout</button>
        <h2>${esc(n.name)}</h2>
        <p class="sub">${esc([n.role, n.org].filter(Boolean).join(' · '))}</p>
        <div class="chips">${chips}</div>
      </header>
      ${!n.met ? `<section class="block"><h3>Intro path</h3>${chain
        ? `<p class="chain"><span>You</span>${chain.map((st) => `<span class="arrow">→</span><button class="link-btn" data-select="${st.id}">${esc(people.get(st.id)!.name)}</button>`).join('')}</p>
           <ul class="why">${chain.slice(1).map((st) => `<li>${esc(st.why)}</li>`).join('')}</ul>
           <div class="row copy-row"><button class="link-btn" data-copy="path" data-target="${n.id}">Copy path</button>
             <button class="link-btn" data-copy="ask" data-target="${n.id}">Copy intro request</button><span class="copied" role="status"></span></div>`
        : '<p class="fine">No one you know is connected to them yet. Add a source where they appear (a contacts list, a group chat) to find a path.</p>'}</section>` : ''}
      <dl class="facts">
        ${fact('Notes', n.notes)}
        ${fact('Source', `${n.sources.join(', ')}${n.sample ? ' (sample)' : ''}`)}
      </dl>
      <section class="block"><h3>Contexts <span class="count">${n.contexts.length}</span></h3>
        <ul class="people">${n.contexts.map((id) => ctx.get(id)!).map((c) => ctxRow(c, c.depth > 1 ? worldName(c.world) : '')).join('')}</ul>
      </section>
      <section class="block"><h3>Connections <span class="count">${conns.length}</span></h3>
        ${conns.length ? `<ul class="people">${conns.map((c) => row(c.p, c.kind) + (c.label ? `<li class="link-note">${esc(c.label)}</li>` : '')).join('')}</ul>` : '<p class="fine">No direct person-to-person links recorded.</p>'}
      </section>`;
  }

  /** A context plus everything nested inside it. */
  function subtree(id: string): Set<string> {
    const within = new Set([id]);
    let grew = true;
    while (grew) { grew = false; for (const x of net.contexts) if (within.has(x.parent) && !within.has(x.id)) { within.add(x.id); grew = true; } }
    return within;
  }
  const headcount = (id: string) => { const w = subtree(id); return net.people.filter((p) => p.contexts.some((c) => w.has(c))).length; };

  function contextDossier(c: Context) {
    const subs = net.contexts.filter((x) => x.parent === c.id).sort((a, b) => headcount(b.id) - headcount(a.id));
    const within = subtree(c.id);
    const members = net.people.filter((p) => p.contexts.some((id) => within.has(id)))
      .sort((a, b) => a.ring - b.ring || a.name.localeCompare(b.name));
    const where = (p: Node) => ctx.get(p.contexts.find((id) => within.has(id))!)!;
    const bridges = members.filter((p) => p.worlds.length > 1).length;

    return `
      <header class="panel-head dossier-head">
        <button class="back" data-select="">← Readout</button>
        ${c.depth > 1 ? `<p class="eyebrow crumb">${esc(path(c))}</p>` : '<p class="eyebrow crumb">World</p>'}
        <h2>${esc(c.name)}</h2>
        <p class="sub">${esc([c.years, c.role].filter(Boolean).join(' · '))}</p>
      </header>
      <div class="stats two">
        <div><b>${members.length}</b><span>people</span></div>
        <div><b>${bridges}</b><span>also in other worlds</span></div>
      </div>
      ${subs.length ? `<section class="block"><h3>Inside <span class="count">${subs.length}</span></h3>
        <ul class="people">${subs.map((x) => ctxRow(x, `${headcount(x.id)}`)).join('')}</ul></section>` : ''}
      <section class="block"><h3>People <span class="count">${members.length}</span></h3>
        ${members.length ? `<ul class="people">${members.map((p) => row(p, where(p).id === c.id ? RINGS[p.ring - 1].label : where(p).name)).join('')}</ul>` : '<p class="fine">Nobody recorded here yet.</p>'}
      </section>`;
  }

  const person = s.selected ? people.get(s.selected) : undefined;
  const context = s.selected ? ctx.get(s.selected) : undefined;
  el.innerHTML = person ? personDossier(person) : context ? contextDossier(context) : readout();
  el.scrollTop = 0;
}

/** Copy an intro path, or a ready-to-send intro request, for the person shown in the panel. */
export function bindPanelCopy(el: HTMLElement, net: () => Network) {
  el.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-copy]');
    if (!b) return;
    const text = introText(net(), b.dataset.target!, b.dataset.copy as 'path' | 'ask');
    const note = el.querySelector('.copied');
    try {
      await navigator.clipboard.writeText(text);
      if (note) note.textContent = 'Copied.';
    } catch {
      // Clipboard blocked (some browsers, insecure contexts): show the text to copy by hand.
      if (note) note.textContent = text;
    }
  });
}
