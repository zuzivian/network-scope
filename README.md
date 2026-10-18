# Network Scope

A topological map of your network: the worlds you move in (school, work, teams, communities), the contexts inside them, and the people who connect them. It runs entirely in your browser, and your data never leaves your device.

**Live:** https://network.natwong.dev

```bash
npm install && npm run dev        # http://localhost:5179
npm test                          # importer tests
npm run check:public              # build the public bundle and scan it for private terms
```

## Importing your data

Open the **Data** screen and drop in any of these (or a .zip of them):

| Source | File |
|---|---|
| LinkedIn | `Connections.csv` from Settings → Data privacy → Get a copy of your data |
| iPhone / Mac / Google contacts | vCard (`.vcf`) export |
| Google, Outlook or Notion | CSV export (you confirm the column mapping) |
| WhatsApp | an exported chat `.txt` (who spoke and when; message text is never kept) |
| Calendar | `.ics` export from Google, Outlook or Apple Calendar: who you meet, how often, recurring meetings as groups |
| Facebook / Instagram | `friends.json`, `followers_1.json`, `following.json` from the data download |

Drop LinkedIn's whole export zip rather than just `Connections.csv`: it includes your own education and jobs, so classmates and colleagues land in the right world (by their company, or by when you connected while at school) instead of one catch-all. Groups, labels and shared companies become contexts. Tags in contact names ("Alex Rivera MBA'28", "Lena Brightwater (Run club)") can be mapped to contexts, and the **Sort** view places everyone else one keystroke at a time.

## Privacy

- Files are parsed on your device (`src/importers/`, pure functions with tests). Phone numbers, emails, addresses, notes and chat message text are dropped at parse time; `privacy.test.ts` checks that for every parser.
- Your network is saved in this browser's IndexedDB. **Download a backup** moves it to another device; **Delete everything** removes it.
- No server, accounts, analytics or cookies. The page ships a Content-Security-Policy whose `connect-src` allows only the feedback form (Formspree, sent only when you press Send, carrying only what you typed), so the browser blocks any other request that could carry your data away. Fonts come from Google Fonts. The full explanation is [privacy.html](public/privacy.html).
- The app asks the browser for persistent storage, tracks your last backup and warns when the browser may clear the map (Safari does after 7 days without a visit; installing to the Home Screen avoids it).
- People with the same name at different companies stay separate and are listed under **Data → Possible duplicates**, along with nickname pairs (Bob / Robert Smith), to merge or keep apart.

## The model

A graph with three kinds of node and two kinds of edge.

- **Nodes:** you (centre) → **worlds** (ringed circles) → **contexts** inside them (diamonds) → **people** (dots).
- **Structural edges:** world → context → person. Someone in several contexts gets several edges, so people who span worlds (**bridges**) sit between clusters.
- **Social edges:** partner/family (solid), intro (dashed), knows (dotted).
- **Person dot:** darker = closer; hollow = not met yet. Core and active people glow softly.
- **Intro path:** for anyone you haven't met, the best chain from someone you know: direct links first, then people who share a small group with them. Copy it as text, or as a ready-to-send intro request.

Colour does one job (closeness, in one indigo); worlds are shown by structure and labels, which holds up under colour-vision deficiency. The **Scope** view is the same data on a radar: bearing = world, ring = closeness.

## Local mode

If `data/graph.json` exists (gitignored), `npm run dev` reads your own files instead of the browser workspace: a hand-built graph plus importer outputs (`scripts/import_whatsapp.py` for WhatsApp Desktop's local databases, read-only; `scripts/import_linkedin.py` for LinkedIn). The Data screen's **Source** switch flips between local files and a browser workspace. Sort decisions save to `data/assignments.json` through a dev-only endpoint.

**Use your local network on the live site:** `npm run export:live` writes a backup file to `data/export/` (gitignored), with your graph, importer overlays and CRM tracker rows. Open the site, then **Data → Restore a backup**. The file is read in your browser and kept in that browser's storage only.

**Nothing under `data/` ships or gets committed**, except the fictional sample in `data/fixtures/`. `vite build --mode public` swaps `src/local-data.ts` for an empty stub, and `npm run check:public` builds that bundle and scans it for every term in `data/leak-terms.txt` and every real name in your local graph files.

## Deploy

Pushes to `main` deploy to Vercel through its GitHub integration (`vercel.json`: `npm run build:public` → `dist/`). GitHub Actions runs the typecheck, tests and public build on every push and pull request. `.vercelignore` keeps `data/` out of CLI uploads too.

## Code

- `src/model.ts`: types, source adapters, intro paths
- `src/graph.ts`: force-directed graph (d3-force, drag, zoom, focus, label placement)
- `src/layout.ts`, `src/scope.ts`: the radar Scope view
- `src/panel.ts`: readout, person and context dossiers, intro paths
- `src/tips.ts`, `src/feedback.ts`: guided tips, feedback form
- `src/importers/`: in-browser parsers and tag extraction
- `src/workspace.ts`: the browser workspace (IndexedDB), import merging, tag rules, backup and restore
- `src/dataview.ts`: Data screen; `src/sort.ts`, `src/browser-sort.ts`: Sort
- `src/local-data.ts`: local-mode loader (stubbed out of the public build)
