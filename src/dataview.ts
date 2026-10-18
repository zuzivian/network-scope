// Data screen: import files, map tags, edit contexts, back up or wipe the browser workspace.
// Every file is read with FileReader/fflate on this device. Nothing is uploaded.
import { unzipSync, strFromU8 } from 'fflate';
import { csvToResult, importFile } from './importers';
import type { CsvMapping, CsvPreset, ImportResult } from './importers/types';
import type { Sources } from './model';
import {
  clearWorkspace, defaultWorldName, discoveredTags, effectiveContexts, exportWorkspace, mergeImport, parseWorkspace,
  pruneContexts, removeImport, saveWorkspace, storageAvailable, workspaceFromSources, type Workspace,
} from './workspace';

export type Mode = 'local' | 'browser' | 'demo';

export interface DataViewEnv {
  mode: Mode;
  ws: Workspace;
  hasLocalData: boolean;
  localSources: () => Sources | null;
  /** Called after anything that changes the graph, so the app can rebuild before showing it. */
  markDirty: () => void;
  reload: (view?: string) => void;
  /** Switch view in place (no reload). */
  show: (view: string) => void;
}

interface Pending {
  id: string;
  file: string;
  result?: ImportResult;
  csv?: { headers: string[]; rows: string[][]; preset: CsvPreset; mapping: CsvMapping };
  world: { id?: string; newName?: string };
  groupContexts: boolean;
  companyContexts: boolean;
  error?: string;
  done?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Files worth reading inside an export zip. Everything else (messages, ads data…) is skipped unread. */
const ZIP_KEEP = /(^|\/)(connections\.csv|_chat\.txt|[^/]*\.vcf|friends[^/]*\.json|followers[^/]*\.json|following[^/]*\.json)$/i;

const GUIDES: { title: string; steps: string }[] = [
  { title: 'LinkedIn connections', steps: 'LinkedIn → Me → Settings & Privacy → Data privacy → Get a copy of your data → pick “Connections” → Request archive. The email link gives a zip; drop the zip or Connections.csv here. Email addresses are dropped.' },
  { title: 'iPhone / Mac Contacts', steps: 'Mac: open Contacts, select All Contacts, File → Export → Export vCard. iPhone: easiest via iCloud.com → Contacts → select all → Export vCard. Groups become contexts; phone numbers, emails, addresses and notes are dropped.' },
  { title: 'Google Contacts', steps: 'contacts.google.com → Export → Google CSV (or vCard). Labels become contexts.' },
  { title: 'WhatsApp chats', steps: 'In a chat or group: ⋮ / contact name → Export chat → Without media. Drop the .txt or .zip. Only who spoke and when is kept: message text is never stored, and unsaved phone numbers are skipped.' },
  { title: 'Facebook friends', steps: 'Facebook → Settings → Your information → Download your information → choose “Friends and followers”, format JSON. Drop friends.json or the zip.' },
  { title: 'Instagram', steps: 'Instagram → Accounts Center → Your information and permissions → Download your information → “Followers and following”, format JSON. Followers count as weak ties until you place them.' },
  { title: 'Notion, Airtable or any spreadsheet', steps: 'Export the table as CSV. You choose which column is the name, company, groups and last-contact date. Columns you don’t map are ignored.' },
];

/** The three quickest starts, shown as tiles on the first-run screen. Everything else sits under "More sources". */
const SOURCES: { id: string; title: string; time: string; blurb: string; steps: string[] }[] = [
  {
    id: 'contacts', title: 'Phone contacts', time: 'About 1 minute', blurb: 'iPhone, Mac, Android or Google',
    steps: [
      'iPhone or Mac: go to icloud.com/contacts (or open Contacts on a Mac), select all, then <b>Export vCard</b>.',
      'Android or Google: go to contacts.google.com, then <b>Export → vCard</b>.',
      'Drop the .vcf file below. Groups and labels become circles; phone numbers and emails are dropped.',
    ],
  },
  {
    id: 'linkedin', title: 'LinkedIn', time: 'About 10 minutes', blurb: 'Companies become clusters',
    steps: [
      'On LinkedIn: <b>Me → Settings &amp; Privacy → Data privacy → Get a copy of your data</b>.',
      'Tick <b>Connections</b> only, then Request archive. LinkedIn emails a link, usually within 10 minutes.',
      'Drop the zip or Connections.csv below. Email addresses are dropped.',
    ],
  },
  {
    id: 'sheet', title: 'A spreadsheet', time: 'About 1 minute', blurb: 'Notion, Airtable, Excel, Outlook',
    steps: [
      'Export your table or contact list as CSV.',
      'Drop it below, then pick which columns hold the name, company and groups.',
      'Columns you don’t pick are ignored and never stored.',
    ],
  },
];
const MORE = ['WhatsApp chats', 'Facebook friends', 'Instagram'];

export function mountDataView(host: HTMLElement, env: DataViewEnv) {
  const ws = env.ws;
  const pending: Pending[] = [];
  let flash = '';
  let source: string | null = null;

  const worlds = () => ws.contexts.filter((c) => c.parent === 'me');
  const ctxPath = (id: string) => {
    const m = new Map(ws.contexts.map((c) => [c.id, c]));
    const parts: string[] = [];
    for (let c = m.get(id); c; c = m.get(c.parent)) parts.unshift(c.name);
    return parts.join(' › ');
  };
  /** People in a context or anything nested inside it. */
  const headcount = (id: string) => {
    const inside = new Set([id]);
    for (let grew = true; grew;) { grew = false; for (const c of ws.contexts) if (inside.has(c.parent) && !inside.has(c.id)) { inside.add(c.id); grew = true; } }
    return ws.people.filter((p) => effectiveContexts(ws, p).some((c) => inside.has(c))).length;
  };

  async function commit(msg: string) {
    pruneContexts(ws);
    await saveWorkspace(ws);
    env.markDirty();
    flash = msg;
    render();
  }

  // ---------- Reading files ----------

  async function readFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      if (/\.zip$/i.test(f.name)) {
        try {
          const entries = unzipSync(new Uint8Array(await f.arrayBuffer()), { filter: (e) => ZIP_KEEP.test(e.name) });
          const names = Object.keys(entries);
          if (!names.length) pending.push(newPending(f.name, { error: 'Nothing importable in this zip (looked for Connections.csv, _chat.txt, .vcf, friends/followers .json).' }));
          for (const n of names) addText(`${f.name} › ${n}`, n, strFromU8(entries[n]));
        } catch (e) {
          pending.push(newPending(f.name, { error: `Couldn't open the zip: ${(e as Error).message}` }));
        }
      } else if (/\.(csv|vcf|txt|json)$/i.test(f.name)) {
        addText(f.name, f.name, await f.text());
      } else {
        pending.push(newPending(f.name, { error: 'Unsupported file type. Use .csv, .vcf, .txt (WhatsApp), .json (Facebook/Instagram) or a .zip of those.' }));
      }
    }
    render();
  }

  function newPending(file: string, extra: Partial<Pending>): Pending {
    return { id: Math.random().toString(36).slice(2), file, world: {}, groupContexts: true, companyContexts: true, ...extra };
  }

  function addText(label: string, name: string, text: string) {
    try {
      const r = importFile({ name, text });
      if ('needsMapping' in r) pending.push(newPending(label, { csv: { headers: r.headers, rows: r.rows, preset: r.preset, mapping: r.mapping } }));
      else pending.push(withDefaults(newPending(label, { result: r })));
    } catch (e) {
      pending.push(newPending(label, { error: (e as Error).message }));
    }
  }

  function withDefaults(p: Pending): Pending {
    if (!p.result) return p;
    const name = defaultWorldName(p.result.kind);
    const existing = worlds().find((w) => w.name.toLowerCase() === name.toLowerCase());
    p.world = existing ? { id: existing.id } : { newName: name };
    return p;
  }

  // ---------- Render ----------

  function render() {
    const empty = env.mode === 'browser' && ws.people.length === 0;
    const local = env.mode === 'local';
    if (empty) {
      host.innerHTML = `<div class="data onboarding">${firstRun()}</div>`;
      return;
    }
    host.innerHTML = `<div class="data">
      ${flash ? `<p class="flash" role="status">${esc(flash)}${ws.people.length ? ' <button class="link-btn" data-see-map>See your map →</button>' : ''}</p>` : ''}
      ${env.hasLocalData ? sourceSwitch() : ''}
      ${local ? `<section class="dv-block"><h2>Import</h2><p class="fine">You're viewing your local files, which the Python importer maintains. To try the in-browser importers, switch the source to Browser workspace above; your local files stay as they are.</p></section>` : `<section class="dv-block" id="import"><h2>Add a source</h2>
        ${sourcePicker()}
      </section>`}
      ${local || !ws.people.length ? '' : yourData() + tags() + contexts()}
      ${privacy()}
      ${storage()}
    </div>`;
  }

  /** Source tiles, the chosen source's steps, the drop zone and any files waiting to be added. */
  function sourcePicker() {
    const pick = SOURCES.find((x) => x.id === source);
    return `<div class="sources" role="group" aria-label="Choose a source">
        ${SOURCES.map((x) => `<button class="source" data-src-tile="${x.id}" aria-pressed="${x.id === source}">
          <b>${esc(x.title)}</b><span>${esc(x.blurb)}</span><small>${esc(x.time)}</small></button>`).join('')}
      </div>
      ${pick ? `<ol class="steps">${pick.steps.map((t) => `<li>${t}</li>`).join('')}</ol>` : ''}
      ${dropZone()}
      ${pending.map(pendingCard).join('')}
      <details class="guides"><summary>More sources: WhatsApp, Facebook, Instagram</summary>
        ${GUIDES.filter((g) => MORE.includes(g.title)).map((g) => `<div class="guide"><b>${esc(g.title)}</b><p>${esc(g.steps)}</p></div>`).join('')}
      </details>`;
  }

  /** First run: one decision (which source), one drop zone, privacy in a sentence. Everything else comes later. */
  function firstRun() {
    return `<section class="hero">
        <h1>Make your map</h1>
        <p>Start with one source. You’ll see your network in about a minute, and the file never leaves this browser.</p>
      </section>
      ${sourcePicker()}
      <p class="lock"><b>Private by design.</b> Files are read here in your browser and saved only in this browser. Nothing is uploaded: no account, no server, no tracking. Phone numbers, emails and message text are dropped as files are read.</p>
      <p class="fine aside"><button class="linkish" data-sample>Back to the sample</button> ·
        <label class="linkish">Restore a backup<input type="file" id="restore" accept=".json" hidden /></label></p>`;
  }

  function dropZone() {
    return `<label class="drop" data-drop>
        <input type="file" id="files" multiple accept=".csv,.vcf,.txt,.json,.zip" hidden />
        <b>Drop a file here</b> or <span class="linkish">choose one</span>
        <small>.vcf, .csv, .zip, WhatsApp .txt or Facebook/Instagram .json</small>
      </label>`;
  }

  function privacy() {
    const where = env.mode === 'local' ? 'your local files in <code>data/</code> (gitignored)' : 'this browser only (IndexedDB for this site)';
    return `<section class="privacy">
      <h2>Your data stays on this device</h2>
      <ul>
        <li>Files are read in your browser. Nothing is uploaded, and there's no account or server.</li>
        <li>Saved to ${where}.${storageAvailable ? '' : ' <b>Storage is blocked here (private window?), so nothing will persist after you close the tab.</b>'}</li>
        <li>Phone numbers, emails, addresses, notes and message text are dropped on import.</li>
        <li>Delete everything at any time under Storage below.</li>
      </ul>
    </section>`;
  }

  function sourceSwitch() {
    return `<section class="dv-block"><h2>Source</h2>
      <div class="seg wide" role="group">
        <button data-source="local" aria-pressed="${env.mode === 'local'}">Local files (data/)</button>
        <button data-source="browser" aria-pressed="${env.mode === 'browser'}">Browser workspace</button>
      </div>
      <p class="fine">Local files are your own setup on this machine. The browser workspace is what visitors to the public site get.
        ${env.mode === 'browser' ? 'Your local files are untouched.' : ''}</p>
      ${env.mode === 'local' ? '<button data-copy-local>Copy my local network into a browser workspace</button>' : ''}
    </section>`;
  }

  function worldPicker(p: Pending) {
    const opts = worlds().map((w) => `<option value="${w.id}" ${p.world.id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
    return `<label>Put them in <select data-world="${p.id}">
        ${opts}<option value="__new" ${p.world.id ? '' : 'selected'}>New world…</option></select></label>
      ${p.world.id ? '' : `<input data-world-name="${p.id}" value="${esc(p.world.newName ?? '')}" placeholder="World name" />`}`;
  }

  function pendingCard(p: Pending) {
    if (p.done) return `<article class="pending done"><b>${esc(p.file)}</b><span>${esc(p.done)}</span></article>`;
    if (p.error) return `<article class="pending err"><b>${esc(p.file)}</b><span>${esc(p.error)}</span><button data-discard="${p.id}">Dismiss</button></article>`;
    if (p.csv && !p.result) return mappingCard(p);
    // Your own name shows up in chat exports; it's never imported, so leave it out of the counts.
    const me = ws.me.name.toLowerCase();
    const r = { ...p.result!, people: p.result!.people.filter((x) => x.name.toLowerCase() !== me) };
    const orgs = new Map<string, number>();
    for (const x of r.people) if (x.org) orgs.set(x.org, (orgs.get(x.org) ?? 0) + 1);
    const shared = [...orgs.values()].filter((n) => n >= 2).length;
    return `<article class="pending">
      <header><b>${esc(r.source)}</b><small>${esc(p.file)}</small></header>
      <p class="counts">${r.people.length} people${r.groups.length ? ` · ${r.groups.length} groups` : ''}${shared ? ` · ${shared} shared companies` : ''}</p>
      ${r.dropped.length ? `<p class="fine">Not kept: ${esc(r.dropped.join(', '))}</p>` : ''}
      ${r.warnings.map((w) => `<p class="fine warn">${esc(w)}</p>`).join('')}
      <p class="fine">e.g. ${esc(r.people.slice(0, 6).map((x) => x.name).join(', '))}${r.people.length > 6 ? '…' : ''}</p>
      <div class="row"><button class="primary" data-commit="${p.id}" ${r.people.length ? '' : 'disabled'}>Add ${r.people.length} people to my map</button>
        <button data-discard="${p.id}">Discard</button></div>
      <details class="more-opts"><summary>Options</summary><div class="opts">${worldPicker(p)}
        ${r.groups.length ? `<label><input type="checkbox" data-opt="groupContexts" data-id="${p.id}" ${p.groupContexts ? 'checked' : ''}/> A circle per group</label>` : ''}
        ${shared ? `<label><input type="checkbox" data-opt="companyContexts" data-id="${p.id}" ${p.companyContexts ? 'checked' : ''}/> A circle per shared company</label>` : ''}
        <label class="you">Your name, so you’re left out <input id="me-name" value="${esc(ws.me.name === 'Me' ? '' : ws.me.name)}" placeholder="e.g. Jordan Lee" /></label>
      </div></details>
    </article>`;
  }

  function mappingCard(p: Pending) {
    const { headers, mapping, preset, rows } = p.csv!;
    const sel = (field: keyof CsvMapping, label: string) => `<label>${label}<select data-map="${field}" data-id="${p.id}">
      <option value="">—</option>${headers.map((h) => `<option ${mapping[field] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`;
    const sample = rows.slice(1, 6).map((r) => {
      const at = (h?: string) => (h ? r[headers.indexOf(h)] ?? '' : '');
      return mapping.name ? at(mapping.name) : `${at(mapping.firstName)} ${at(mapping.lastName)}`.trim();
    }).filter(Boolean);
    return `<article class="pending">
      <header><b>Spreadsheet</b><small>${esc(p.file)} · ${rows.length - 1} rows · looks like ${esc(preset)}</small></header>
      <p class="fine">Pick the columns to use. Anything not picked is ignored and never stored.</p>
      <div class="mapping">
        ${sel('name', 'Full name')}${sel('firstName', 'or first name')}${sel('lastName', 'and last name')}
        ${sel('org', 'Company')}${sel('role', 'Title / role')}${sel('lastContact', 'Last contact date')}${sel('status', 'Status')}${sel('notes', 'Notes')}
      </div>
      <fieldset class="groups"><legend>Columns that name groups or contexts</legend>
        ${headers.map((h) => `<label><input type="checkbox" data-group-col="${esc(h)}" data-id="${p.id}" ${mapping.groups.includes(h) ? 'checked' : ''}/> ${esc(h)}</label>`).join('')}
      </fieldset>
      <p class="fine">Names: ${esc(sample.join(', ') || 'pick a name column')}</p>
      <div class="row"><button class="primary" data-map-done="${p.id}" ${mapping.name || mapping.firstName ? '' : 'disabled'}>Continue</button>
        <button data-discard="${p.id}">Discard</button></div>
    </article>`;
  }

  function yourData() {
    return `<section class="dv-block"><h2>Your data</h2>
      <label class="you">Your name <input id="me-name" value="${esc(ws.me.name)}" /></label>
      <p class="fine">${ws.people.length} people · ${ws.contexts.length} contexts · ${Object.keys(ws.decisions).length} sort decisions</p>
      <ul class="imports">${ws.imports.slice().reverse().map((i) => `<li><span><b>${esc(i.source)}</b>
        <small>${new Date(i.at).toLocaleDateString()} · ${i.people} rows</small></span>
        <button data-remove-import="${i.id}" title="Removes people only this import added">Remove</button></li>`).join('')}</ul>
    </section>`;
  }

  function tags() {
    const list = discoveredTags(ws).slice(0, 80);
    if (!list.length) return '';
    const options = (sel: string[]) => `<option value="">—</option>` + ws.contexts.map((c) =>
      `<option value="${c.id}" ${sel.includes(c.id) ? 'selected' : ''}>${esc(ctxPath(c.id))}</option>`).join('');
    return `<section class="dv-block"><h2>Tags</h2>
      <p class="fine">Words in names and company fields that look like labels ("NYC", "2019", "MBA'24"). Map one to a context and everyone carrying it moves there. Create contexts below first if you need new ones.</p>
      <table class="tags"><thead><tr><th>Tag</th><th>People</th><th>e.g.</th><th>Goes to</th></tr></thead><tbody>
      ${list.map((t) => `<tr><td><code>${esc(t.tag)}</code></td><td>${t.count}</td><td class="eg">${esc(t.examples.join(', '))}</td>
        <td><select data-tag="${esc(t.tag)}">${options(t.mapped)}</select></td></tr>`).join('')}
      </tbody></table></section>`;
  }

  function contexts() {
    const kids = (id: string): string => ws.contexts.filter((c) => c.parent === id).map((c) => {
      const n = headcount(c.id);
      const hasKids = ws.contexts.some((x) => x.parent === c.id);
      return `<li><div class="ctx-row">
          <input data-rename="${c.id}" value="${esc(c.name)}" aria-label="Name" />
          <small>${n} people</small>
          <button data-add-child="${c.id}" title="Add a context inside">+ inside</button>
          ${!n && !hasKids ? `<button data-delete="${c.id}" title="Delete">Delete</button>` : ''}
        </div>${hasKids ? `<ul>${kids(c.id)}</ul>` : ''}</li>`;
    }).join('');
    return `<section class="dv-block"><h2>Worlds and contexts</h2>
      <p class="fine">Worlds are the big circles of your life (school, a job, a team); contexts sit inside them.</p>
      <ul class="tree">${kids('me')}</ul>
      <div class="row"><input id="new-world" placeholder="New world, e.g. University" /><button data-add-world>Add world</button></div>
    </section>`;
  }

  function storage() {
    return `<section class="dv-block"><h2>Storage</h2>
      <div class="row">
        <button data-export ${ws.people.length ? '' : 'disabled'}>Download a backup (.json)</button>
        <label class="button">Restore a backup<input type="file" id="restore" accept=".json" hidden /></label>
        <button class="danger" data-clear>Delete everything in this browser</button>
      </div>
      <p class="fine">A backup moves your network to another browser or device. Delete removes the browser workspace for this site${env.hasLocalData ? '; your local files in data/ are not touched' : ''}.</p>
    </section>`;
  }

  // ---------- Events ----------

  const find = (id?: string) => pending.find((p) => p.id === id);

  host.addEventListener('dragover', (e) => { if ((e.target as HTMLElement).closest('[data-drop]')) { e.preventDefault(); host.querySelector('.drop')?.classList.add('over'); } });
  host.addEventListener('dragleave', () => host.querySelector('.drop')?.classList.remove('over'));
  host.addEventListener('drop', (e) => {
    if (!(e.target as HTMLElement).closest('[data-drop]')) return;
    e.preventDefault();
    if (e.dataTransfer?.files.length) readFiles(e.dataTransfer.files);
  });

  host.addEventListener('change', async (e) => {
    const t = e.target as HTMLInputElement & HTMLSelectElement;
    if (t.id === 'files' && t.files) return readFiles(t.files);
    if (t.id === 'restore' && t.files?.[0]) {
      try {
        const next = parseWorkspace(await t.files[0].text());
        if (ws.people.length && !confirm('Replace the network in this browser with the backup?')) return;
        Object.assign(ws, next);
        return commit(`Restored ${next.people.length} people from the backup.`);
      } catch (err) { flash = (err as Error).message; return render(); }
    }
    if (t.id === 'me-name') { ws.me.name = t.value.trim() || 'Me'; return commit('Name saved.'); }
    if (t.dataset.world) {
      const p = find(t.dataset.world)!;
      p.world = t.value === '__new' ? { newName: defaultWorldName(p.result!.kind) } : { id: t.value };
      return render();
    }
    if (t.dataset.worldName) { find(t.dataset.worldName)!.world = { newName: t.value }; return; }
    if (t.dataset.opt) { (find(t.dataset.id) as unknown as Record<string, boolean>)[t.dataset.opt] = t.checked; return; }
    if (t.dataset.map) {
      const p = find(t.dataset.id)!;
      (p.csv!.mapping as unknown as Record<string, unknown>)[t.dataset.map] = t.value || undefined;
      return render();
    }
    if (t.dataset.groupCol) {
      const m = find(t.dataset.id)!.csv!.mapping;
      m.groups = t.checked ? [...m.groups, t.dataset.groupCol] : m.groups.filter((g) => g !== t.dataset.groupCol);
      return render();
    }
    if (t.dataset.tag) {
      if (t.value) ws.tagRules[t.dataset.tag] = [t.value]; else delete ws.tagRules[t.dataset.tag];
      return commit(`Tag ${t.dataset.tag} ${t.value ? `now goes to ${ctxPath(t.value)}` : 'unmapped'}.`);
    }
    if (t.dataset.rename) {
      const c = ws.contexts.find((x) => x.id === t.dataset.rename);
      if (c && t.value.trim()) { c.name = t.value.trim(); return commit('Renamed.'); }
    }
  });

  host.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const b = (sel: string) => t.closest<HTMLElement>(sel);
    if (b('[data-sample]')) return env.show('graph');
    if (b('[data-src-tile]')) { const id = b('[data-src-tile]')!.dataset.srcTile!; source = source === id ? null : id; return render(); }
    if (b('[data-see-map]')) return env.reload('graph');
    if (b('[data-source]')) {
      const v = b('[data-source]')!.dataset.source!;
      try { localStorage.setItem('ns-source', v); } catch { /* per-visit only */ }
      return env.reload('data');
    }
    if (b('[data-copy-local]')) {
      const src = env.localSources();
      if (!src) return;
      const existing = ws.people.length;
      if (existing && !confirm(`Replace the ${existing} people already in this browser workspace?`)) return;
      Object.assign(ws, workspaceFromSources(src));
      await saveWorkspace(ws);
      try { localStorage.setItem('ns-source', 'browser'); } catch { /* ignore */ }
      return env.reload('graph');
    }
    if (b('[data-discard]')) { pending.splice(pending.indexOf(find(b('[data-discard]')!.dataset.discard)!), 1); return render(); }
    if (b('[data-map-done]')) {
      const p = find(b('[data-map-done]')!.dataset.mapDone)!;
      try { p.result = csvToResult(p.csv!.rows, p.csv!.mapping, p.file.replace(/\.csv$/i, '')); withDefaults(p); }
      catch (err) { p.error = (err as Error).message; }
      return render();
    }
    if (b('[data-commit]')) {
      const p = find(b('[data-commit]')!.dataset.commit)!;
      const first = ws.people.length === 0;
      const r = mergeImport(ws, p.result!, { world: p.world, groupContexts: p.groupContexts, companyContexts: p.companyContexts });
      p.done = `${r.added} added, ${r.updated} matched people you already had.`;
      if (first && !pending.some((x) => x.result && !x.done)) {
        // First import: straight to the map. That's the payoff.
        pruneContexts(ws);
        await saveWorkspace(ws);
        return env.reload('graph');
      }
      return commit(`Imported ${p.result!.source}: ${p.done}`);
    }
    if (b('[data-remove-import]')) {
      if (!confirm('Remove this import? People that only it added will be removed.')) return;
      removeImport(ws, b('[data-remove-import]')!.dataset.removeImport!);
      return commit('Import removed.');
    }
    if (b('[data-add-world]')) {
      const input = host.querySelector<HTMLInputElement>('#new-world')!;
      const name = input.value.trim();
      if (!name) return;
      const id = uniqueId(name);
      ws.contexts.push({ id, name, parent: 'me' });
      return commit(`Added world ${name}.`);
    }
    if (b('[data-add-child]')) {
      const parent = b('[data-add-child]')!.dataset.addChild!;
      const name = prompt(`New context inside ${ctxPath(parent)}:`)?.trim();
      if (!name) return;
      ws.contexts.push({ id: uniqueId(name), name, parent });
      return commit(`Added ${name}.`);
    }
    if (b('[data-delete]')) {
      const id = b('[data-delete]')!.dataset.delete!;
      ws.contexts = ws.contexts.filter((c) => c.id !== id);
      for (const k of Object.keys(ws.tagRules)) ws.tagRules[k] = ws.tagRules[k].filter((c) => c !== id);
      return commit('Deleted.');
    }
    if (b('[data-export]')) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(exportWorkspace(ws));
      a.download = `network-scope-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    if (b('[data-clear]')) {
      if (!confirm('Delete every person, context and decision stored in this browser? This cannot be undone (download a backup first if unsure).')) return;
      await clearWorkspace();
      try { localStorage.removeItem('ns-source'); } catch { /* ignore */ }
      return env.reload('data');
    }
  });

  function uniqueId(name: string) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'context';
    let id = base;
    for (let i = 2; ws.contexts.some((c) => c.id === id) || id === 'me'; i++) id = `${base}-${i}`;
    return id;
  }

  render();
  return { render };
}
