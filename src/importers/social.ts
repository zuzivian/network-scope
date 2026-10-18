// Facebook "Download Your Information" and Instagram follower/following JSON exports.
// Both only give display names or usernames plus a timestamp; nothing else is read.

import { makePerson } from './tags';
import type { ImportResult, ImportedPerson } from './types';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Facebook writes UTF-8 bytes as latin1 escapes ("JosÃ©" for "José"). Re-decode when every
 * char is < 256 and the bytes form valid UTF-8; otherwise return the string untouched.
 */
export function fixMojibake(s: string): string {
  let hasHigh = false;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 255) return s;
    if (c > 127) hasHigh = true;
    bytes[i] = c;
  }
  if (!hasHigh) return s;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

/** Unix timestamp (seconds, or milliseconds if huge) to YYYY-MM-DD in UTC. */
function toDate(ts: unknown): string | undefined {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return undefined;
  const ms = ts > 1e11 ? ts : ts * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Facebook friends JSON: `{ friends_v2: [{ name, timestamp }] }` (older: `friends`). */
export function parseFacebookFriends(json: unknown): ImportResult {
  let list: unknown[] = [];
  if (Array.isArray(json)) list = json;
  else if (isRecord(json)) {
    const found = json.friends_v2 ?? json.friends;
    if (Array.isArray(found)) list = found;
  }

  const people: ImportedPerson[] = [];
  let skipped = 0;
  for (const item of list) {
    const rawName = isRecord(item) && typeof item.name === 'string' ? fixMojibake(item.name).trim() : '';
    if (!rawName) {
      skipped++;
      continue;
    }
    const person = makePerson(rawName);
    const connectedOn = toDate(isRecord(item) ? item.timestamp : undefined);
    if (connectedOn) person.connectedOn = connectedOn;
    people.push(person);
  }

  const warnings: string[] = [];
  if (skipped > 0) warnings.push(`${skipped} ${skipped === 1 ? 'entry' : 'entries'} had no name and ${skipped === 1 ? 'was' : 'were'} skipped`);
  if (list.length === 0) warnings.push('No friends found in this file');
  return { kind: 'facebook', source: 'Facebook friends', people, groups: [], warnings, dropped: [] };
}

/** Pull the item list out of followers (bare array) or following (`relationships_*` object) files. */
function instagramItems(json: unknown): { items: unknown[]; shape?: 'followers' | 'following' } {
  if (Array.isArray(json)) return { items: json };
  if (isRecord(json)) {
    if (Array.isArray(json.relationships_following)) return { items: json.relationships_following, shape: 'following' };
    if (Array.isArray(json.relationships_followers)) return { items: json.relationships_followers, shape: 'followers' };
    for (const [key, value] of Object.entries(json)) {
      if (key.startsWith('relationships_') && Array.isArray(value)) return { items: value };
    }
  }
  return { items: [] };
}

/** Instagram followers_1.json / following.json. People are named by username. */
export function parseInstagram(json: unknown, fileName: string): ImportResult {
  const { items, shape } = instagramItems(json);
  const kind: 'followers' | 'following' = /following/i.test(fileName)
    ? 'following'
    : /followers?/i.test(fileName)
      ? 'followers'
      : (shape ?? 'followers');
  const group = kind === 'following' ? 'Instagram following' : 'Instagram followers';

  const people: ImportedPerson[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const item of items) {
    const entry = isRecord(item) && Array.isArray(item.string_list_data) && isRecord(item.string_list_data[0])
      ? item.string_list_data[0]
      : undefined;
    const title = isRecord(item) && typeof item.title === 'string' ? item.title : '';
    const valueField = entry && typeof entry.value === 'string' ? entry.value : '';
    const username = fixMojibake(valueField || title).trim();
    if (!username) {
      skipped++;
      continue;
    }
    if (seen.has(username.toLowerCase())) continue;
    seen.add(username.toLowerCase());

    const person: ImportedPerson = { name: username, raw: username, tags: [], groups: [group] };
    if (entry && typeof entry.href === 'string' && entry.href) person.url = entry.href;
    const connectedOn = toDate(entry?.timestamp);
    if (connectedOn) person.connectedOn = connectedOn;
    people.push(person);
  }

  const warnings: string[] = [];
  if (skipped > 0) warnings.push(`${skipped} ${skipped === 1 ? 'entry' : 'entries'} had no username and ${skipped === 1 ? 'was' : 'were'} skipped`);
  if (items.length === 0) warnings.push('No accounts found in this file');
  return {
    kind: 'instagram',
    source: group,
    people,
    groups: [{ name: group, members: people.map((p) => p.name) }],
    warnings,
    dropped: [],
  };
}

/** Guess which social export a parsed JSON file is. */
export function detectJson(json: unknown, _fileName: string): 'facebook' | 'instagram' | null {
  if (isRecord(json)) {
    if (Array.isArray(json.friends_v2) || Array.isArray(json.friends)) return 'facebook';
    if (Object.entries(json).some(([k, v]) => k.startsWith('relationships_') && Array.isArray(v))) return 'instagram';
    return null;
  }
  if (Array.isArray(json) && json.some((i) => isRecord(i) && Array.isArray(i.string_list_data))) return 'instagram';
  return null;
}
