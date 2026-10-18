// Export your local network (data/*.json) as a Network Scope backup file, to restore on the
// live site: Data → Restore a backup. The file stays on this machine (data/export/, gitignored);
// the site reads it in your browser and keeps it in that browser's storage only.
//
// Run: npm run export:live
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { localSources } from '../src/local-data';
import { workspaceFromSources } from '../src/workspace';

const src = localSources();
if (!src) {
  console.error('No local data (data/graph.json) to export.');
  process.exit(1);
}
const ws = workspaceFromSources(src);
const dir = resolve(import.meta.dirname, '../data/export');
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `network-scope-backup-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(ws));
console.log(`${ws.people.length} people, ${ws.contexts.length} contexts, ${ws.links.length} links, `
  + `${ws.crm?.networking.length ?? 0} tracker + ${ws.crm?.classmates.length ?? 0} classmate rows`);
console.log(file);
