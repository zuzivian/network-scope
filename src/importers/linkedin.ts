// LinkedIn "Connections.csv": a few "Notes:" preamble lines, then the real header row.

import { csvToResult, detectPreset, parseCSV } from './csv';
import type { ImportResult } from './types';

const HEADER_LINE = /^\s*"?First Name"?\s*[,;\t]\s*"?Last Name"?\s*[,;\t].*"?URL"?/i;

/** Index of the real header row in the text's lines, or -1 if this isn't a LinkedIn export. */
export function findLinkedInHeader(lines: string[]): number {
  return lines.findIndex((l) => HEADER_LINE.test(l.replace(/^﻿/, '')));
}

/** True when the text has a LinkedIn connections header row (with or without the preamble). */
export function isLinkedInCsv(text: string): boolean {
  return findLinkedInHeader(text.split(/\r\n|\n|\r/)) >= 0;
}

/** Parse LinkedIn's Connections.csv. Email addresses are never read into the result. */
export function parseLinkedInConnections(text: string): ImportResult {
  const lines = text.split(/\r\n|\n|\r/);
  const at = findLinkedInHeader(lines);
  const source = 'LinkedIn connections';
  if (at < 0) {
    return {
      kind: 'linkedin',
      source,
      people: [],
      groups: [],
      warnings: ['Could not find the LinkedIn header row (First Name, Last Name, URL, ...)'],
      dropped: ['Email Address'],
    };
  }
  const rows = parseCSV(lines.slice(at).join('\n'));
  const { mapping } = detectPreset(rows[0]);
  const connectedOnColumn = rows[0].find((h) => h.trim().toLowerCase() === 'connected on');
  const result = csvToResult(rows, { ...mapping, groups: [] }, source, { kind: 'linkedin', connectedOnColumn });
  if (!result.dropped.includes('Email Address')) result.dropped.push('Email Address');
  return result;
}

// ---------- Your own profile: Education.csv and Positions.csv from the same export ----------

/** One chapter of your own life, from your LinkedIn profile. Dates are YYYY-MM-DD. */
export interface TimelineEntry { org: string; kind: 'school' | 'job'; start: string; end?: string }

const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "2015" or "Nov 2023" -> ISO. Year-only school dates mean the academic year (August to June). */
export function profileDate(s: string, end: boolean, school: boolean): string | undefined {
  const t = s.trim();
  const m = /^([A-Za-z]{3})[a-z]* (\d{4})$/.exec(t);
  if (m && MON[m[1].toLowerCase()]) return `${m[2]}-${String(MON[m[1].toLowerCase()]).padStart(2, '0')}-${end ? '28' : '01'}`;
  if (/^\d{4}$/.test(t)) return school ? `${t}-${end ? '06-30' : '08-01'}` : `${t}-${end ? '12-31' : '01-01'}`;
  return undefined;
}

/** Which of your profile files this is, by its header row. */
export function profileKind(text: string): 'education' | 'positions' | null {
  const head = text.replace(/^﻿/, '').split(/\r\n|\n|\r/, 1)[0].toLowerCase();
  if (head.includes('school name') && head.includes('start date')) return 'education';
  if (head.includes('company name') && head.includes('started on')) return 'positions';
  return null;
}

/** Your schools and jobs with their dates. Descriptions, notes and activities are never read. */
export function parseProfile(text: string): TimelineEntry[] {
  const kind = profileKind(text);
  if (!kind) return [];
  const rows = parseCSV(text);
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const col = (name: string) => h.indexOf(name);
  const [org, start, end] = kind === 'education'
    ? [col('school name'), col('start date'), col('end date')]
    : [col('company name'), col('started on'), col('finished on')];
  const school = kind === 'education';
  return rows.slice(1).flatMap((r): TimelineEntry[] => {
    const name = (r[org] ?? '').trim();
    const a = profileDate(r[start] ?? '', false, school);
    if (!name || !a) return [];
    return [{ org: name, kind: school ? 'school' : 'job', start: a, end: profileDate(r[end] ?? '', true, school) }];
  });
}

/** Organisation names compared loosely: "Amazon Web Services (AWS)" matches your "Amazon". */
export function orgKey(s: string): string {
  return s.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/\b(inc|llc|ltd|pte|plc|co|corp|corporation|company|the)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function sameOrg(a: string, b: string): boolean {
  const x = orgKey(a), y = orgKey(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}-`) || y.startsWith(`${x}-`);
}
