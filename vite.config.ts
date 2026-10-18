import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const ASSIGNMENTS = resolve(import.meta.dirname, 'data/assignments.json');
const SYNC_TOKEN = resolve(import.meta.dirname, 'data/.sync-token');
const LINKEDIN_CSV = resolve(import.meta.dirname, 'data/linkedin/connections.csv');
const NOTION_FILES: Record<string, string> = {
  networking: 'data/notion/networking-tracker.json',
  classmates: 'data/notion/classmate-network.json',
  encounters: 'data/notion/encounters.json',
};
// Never written to disk from Notion: phone numbers.
const DROP_FIELDS = new Set(['Phone']);

function body(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 5_000_000) fail(new Error('too large')); });
    req.on('end', () => ok(s));
    req.on('error', fail);
  });
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

/** Dev-only API for the Sort screen: saves decisions locally and reruns the local importers. */
function sortApi(): Plugin {
  return {
    name: 'sort-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/assignments', async (req, res) => {
        if (req.method === 'GET') {
          return send(res, 200, existsSync(ASSIGNMENTS) ? JSON.parse(readFileSync(ASSIGNMENTS, 'utf8')) : { contexts: [], decisions: {} });
        }
        if (req.method === 'POST') {
          try {
            const data = JSON.parse(await body(req));
            if (typeof data !== 'object' || !data || typeof data.decisions !== 'object' || !Array.isArray(data.contexts)) {
              return send(res, 400, { error: 'expected {contexts: [], decisions: {}}' });
            }
            writeFileSync(ASSIGNMENTS, JSON.stringify(data, null, 1));
            return send(res, 200, { ok: true, decisions: Object.keys(data.decisions).length });
          } catch (e) {
            return send(res, 400, { error: String(e) });
          }
        }
        send(res, 405, { error: 'GET or POST' });
      });
      // Receives rows posted from a signed-in Notion tab (cross-origin, so token-guarded).
      server.middlewares.use('/api/notion-import', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
        try {
          const token = existsSync(SYNC_TOKEN) ? readFileSync(SYNC_TOKEN, 'utf8').trim() : '';
          const data = JSON.parse(await body(req));
          if (!token || data.token !== token) return send(res, 403, { error: 'bad token' });
          const file = NOTION_FILES[data.name];
          if (!file || !Array.isArray(data.rows)) return send(res, 400, { error: 'unknown table' });
          const rows = data.rows.map((r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => !DROP_FIELDS.has(k))));
          writeFileSync(resolve(import.meta.dirname, file), JSON.stringify(rows, null, 1));
          return send(res, 200, { ok: true, rows: rows.length });
        } catch (e) {
          return send(res, 400, { error: String(e) });
        }
      });
      server.middlewares.use('/api/reimport', (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
        // LinkedIn runs after WhatsApp (it matches against imported.json), if a LinkedIn export was imported once.
        const cmd = existsSync(LINKEDIN_CSV)
          ? 'python3 -I scripts/import_whatsapp.py && python3 -I scripts/import_linkedin.py'
          : 'python3 -I scripts/import_whatsapp.py';
        execFile('sh', ['-c', cmd], { cwd: import.meta.dirname, timeout: 120_000 }, (err, stdout, stderr) => {
          if (err) return send(res, 500, { error: stderr || String(err) });
          const appliedAt = new Date().toISOString();
          if (existsSync(ASSIGNMENTS)) {
            const data = JSON.parse(readFileSync(ASSIGNMENTS, 'utf8'));
            writeFileSync(ASSIGNMENTS, JSON.stringify({ ...data, appliedAt }, null, 1));
          }
          send(res, 200, { ok: true, appliedAt, summary: stdout.trim().split('\n')[0] });
        });
      });
    },
  };
}

/**
 * Public build only: a Content-Security-Policy whose connect-src allows only the feedback form,
 * so the browser itself refuses any other request that could carry imported data off the device
 * (vercel.json sends the same policy as a header, plus frame-ancestors).
 */
export const PUBLIC_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
  + "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src https://formspree.io; form-action 'none'; base-uri 'none'; object-src 'none'";

function publicCsp(): Plugin {
  return {
    name: 'public-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n  <meta http-equiv="Content-Security-Policy" content="${PUBLIC_CSP}" />`),
  };
}

export default defineConfig(({ mode }) => ({
  // The public build must never bundle data/ (Nat's real network): swap in an empty loader.
  resolve: mode === 'public'
    ? { alias: [{ find: /^\.\/local-data$/, replacement: resolve(import.meta.dirname, 'src/local-data.stub.ts') }] }
    : {},
  plugins: mode === 'public' ? [publicCsp()] : [sortApi()],
  // Saving a decision must not reload the page mid-sort.
  server: { watch: { ignored: ['**/data/assignments.json', '**/data/import-review.md', '**/data/linkedin-review.md'] } },
}));
