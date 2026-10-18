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
| Facebook / Instagram | `friends.json`, `followers_1.json`, `following.json` from the data download |

Groups, labels and shared companies become contexts. Tags in contact names ("MAJ Alex Rivera 140", "Lena Brightwater GSB'28") can be mapped to contexts, and the **Sort** view places everyone else one keystroke at a time.

## Privacy

- Files are parsed on your device (`src/importers/`, pure functions with tests). Phone numbers, emails, addresses, notes and chat message text are dropped at parse time; `privacy.test.ts` checks that for every parser.
- Your network is saved in this browser's IndexedDB. **Download a backup** moves it to another device; **Delete everything** removes it.
- No server, accounts, analytics or cookies. The page ships a Content-Security-Policy with `connect-src 'none'`, so the browser blocks any request that could carry your data away. The only outside request is Google Fonts.

## The model

A graph with three kinds of node and two kinds of edge.

- **Nodes:** you (centre) → **worlds** (ringed circles) → **contexts** inside them (diamonds) → **people** (dots).
- **Structural edges:** world → context → person. Someone in several contexts gets several edges, so people who span worlds (**bridges**) sit between clusters.
- **Social edges:** partner/family (solid), intro/warm path (dashed), knows (dotted).
- **Person dot:** brightness = recency (halves every half-life days), hollow = not met yet, amber ring = follow-up due, thank-you owed or gone quiet.
- **Warm path:** for anyone you haven't met, the shortest chain of social edges from someone you have.

Colour does one job (recency, plus amber for attention); worlds are shown by structure and labels, which holds up under colour-vision deficiency. The **Scope** view is the same data on a radar: bearing = world, ring = closeness.

## Local mode

If `data/graph.json` exists (gitignored), `npm run dev` reads your own files instead of the browser workspace: a hand-built graph plus importer outputs (`scripts/import_whatsapp.py` for WhatsApp Desktop's local databases, read-only; `scripts/import_linkedin.py` for LinkedIn). The Data screen's **Source** switch flips between local files and a browser workspace. Sort decisions save to `data/assignments.json` through a dev-only endpoint.

**Nothing under `data/` ships or gets committed**, except the fictional sample in `data/fixtures/`. `vite build --mode public` swaps `src/local-data.ts` for an empty stub, and `npm run check:public` builds that bundle and scans it for every term in `data/leak-terms.txt` and every real name in your local graph files.

## Deploy

Pushes to `main` deploy to Vercel through its GitHub integration (`vercel.json`: `npm run build:public` → `dist/`). GitHub Actions runs the typecheck, tests and public build on every push and pull request. `.vercelignore` keeps `data/` out of CLI uploads too.

## Code

- `src/model.ts`: types, source adapters, derived recency and flags
- `src/graph.ts`: force-directed graph (d3-force, drag, zoom, focus, label placement)
- `src/layout.ts`, `src/scope.ts`: the radar Scope view
- `src/panel.ts`: readout, person and context dossiers, warm paths
- `src/importers/`: in-browser parsers and tag extraction
- `src/workspace.ts`: the browser workspace (IndexedDB), import merging, tag rules, backup and restore
- `src/dataview.ts`: Data screen; `src/sort.ts`, `src/browser-sort.ts`: Sort
- `src/local-data.ts`: local-mode loader (stubbed out of the public build)
