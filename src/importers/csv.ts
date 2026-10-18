// CSV parsing, preset detection and conversion to people. Handles Google Contacts,
// Outlook, LinkedIn, Notion exports and anything else via a column mapping.
// Contact details (email, phone, address, birthday) are never copied into results.

import type { CsvMapping, CsvPreset, ImportKind, ImportResult, ImportedPerson } from './types';
import { makePerson } from './tags';

// ---------- parsing ----------

/** Pick `,`, `;` or tab from the first line (outside quotes); comma wins unless absent. */
function detectDelimiter(text: string): string {
  let commas = 0;
  let semis = 0;
  let tabs = 0;
  let inQuotes = false;
  for (const c of text) {
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (c === '\n' || c === '\r') break;
      if (c === ',') commas++;
      else if (c === ';') semis++;
      else if (c === '\t') tabs++;
    }
  }
  if (commas > 0) return ',';
  if (tabs > 0 && tabs >= semis) return '\t';
  if (semis > 0) return ';';
  return ',';
}

/** RFC 4180 CSV parser. Strips a BOM, drops blank rows, auto-detects `;`/tab delimiters. */
export function parseCSV(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += c;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

// ---------- dates ----------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function ymd(y: number, m: number, d: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function monthNumber(word: string): number | undefined {
  return MONTHS[word.slice(0, 3).toLowerCase()];
}

/**
 * Parse common date spellings to YYYY-MM-DD: ISO, "Oct 1, 2026", "1 Oct 2026",
 * "01 Oct 2026" and numeric "10/01/2026" (US month/day unless the first number exceeds 12).
 * Returns undefined when unparseable or ambiguous beyond that rule.
 */
export function parseLooseDate(input: string): string | undefined {
  const s = input.trim();
  if (!s) return undefined;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/.exec(s) ?? /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);

  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(s);
  if (m) {
    const mo = monthNumber(m[1]);
    return mo ? ymd(+m[3], mo, +m[2]) : undefined;
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4})\b/.exec(s);
  if (m) {
    const mo = monthNumber(m[2]);
    return mo ? ymd(+m[3], mo, +m[1]) : undefined;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:$|[\sT,])/.exec(s);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    if (a > 12 && b <= 12) return ymd(+m[3], b, a);
    if (a <= 12) return ymd(+m[3], a, b);
  }
  return undefined;
}

// ---------- preset detection ----------

const norm = (h: string) => h.replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ');

/** First header matching any of the names (names listed in priority order). */
function pick(headers: string[], names: string[]): string | undefined {
  for (const n of names) {
    const h = headers.find((x) => norm(x) === n);
    if (h !== undefined) return h;
  }
  return undefined;
}

/** All headers matching any of the names, in name order. */
function pickAll(headers: string[], names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const h = headers.find((x) => norm(x) === n);
    if (h !== undefined && !out.includes(h)) out.push(h);
  }
  return out;
}

function compact(m: CsvMapping): CsvMapping {
  const out: CsvMapping = { groups: m.groups };
  for (const k of ['name', 'firstName', 'lastName', 'org', 'role', 'lastContact', 'status', 'notes', 'url'] as const) {
    if (m[k] !== undefined) out[k] = m[k];
  }
  return out;
}

/** Suggest a preset and column mapping from header names (case-insensitive). */
export function detectPreset(headers: string[]): { preset: CsvPreset; mapping: CsvMapping } {
  const has = (...names: string[]) => names.every((n) => pick(headers, [n]) !== undefined);
  const first = pick(headers, ['first name']);
  const last = pick(headers, ['last name']);

  if (has('first name', 'last name', 'url') && (has('connected on') || (has('company') && has('position')))) {
    return {
      preset: 'linkedin',
      mapping: compact({
        firstName: first,
        lastName: last,
        org: pick(headers, ['company']),
        role: pick(headers, ['position']),
        url: pick(headers, ['url']),
        groups: [],
      }),
    };
  }

  const gOrg = pick(headers, ['organization name', 'organization 1 - name']);
  const gLabels = pick(headers, ['labels']);
  if (first && (gOrg || gLabels)) {
    return {
      preset: 'google',
      mapping: compact({
        firstName: first,
        lastName: last,
        org: gOrg,
        role: pick(headers, ['organization title', 'organization 1 - title']),
        groups: gLabels ? [gLabels] : [],
      }),
    };
  }

  const oCompany = pick(headers, ['company']);
  const oTitle = pick(headers, ['job title']);
  const oCats = pick(headers, ['categories']);
  if (first && last && (oTitle || oCats) && (oCompany || oTitle)) {
    return {
      preset: 'outlook',
      mapping: compact({
        firstName: first,
        lastName: last,
        org: oCompany,
        role: oTitle,
        groups: oCats ? [oCats] : [],
      }),
    };
  }

  const notionHints = ['status', 'tags', 'company', 'where met', 'how we met', 'last contacted', 'last met', 'last touchpoint', 'role'];
  if (pick(headers, ['name']) && notionHints.some((n) => pick(headers, [n]) !== undefined)) {
    return {
      preset: 'notion',
      mapping: compact({
        name: pick(headers, ['name']),
        org: pick(headers, ['company', 'organization', 'organisation']),
        role: pick(headers, ['role', 'position', 'job title', 'title']),
        status: pick(headers, ['status']),
        groups: pickAll(headers, ['tags', 'where met', 'how we met']),
        lastContact: pick(headers, ['last contacted', 'last met', 'last touchpoint', 'date']),
      }),
    };
  }

  const name = pick(headers, ['name', 'full name', 'display name', 'contact name']);
  return {
    preset: 'generic',
    mapping: compact({
      name,
      firstName: name ? undefined : pick(headers, ['first name', 'firstname', 'given name']),
      lastName: name ? undefined : pick(headers, ['last name', 'lastname', 'surname', 'family name']),
      org: pick(headers, ['company', 'organization', 'organisation', 'employer', 'organization name', 'org']),
      role: pick(headers, ['title', 'position', 'job title', 'role']),
      status: pick(headers, ['status']),
      url: pick(headers, ['url', 'profile url', 'linkedin url', 'linkedin']),
      lastContact: pick(headers, ['last contact', 'last contacted', 'last met', 'last seen', 'date']),
      groups: pickAll(headers, [
        'group', 'groups', 'label', 'labels', 'tag', 'tags', 'category', 'categories', 'circle', 'team', 'where met',
      ]),
    }),
  };
}

// ---------- conversion ----------

/** Split a group cell on `,` `;` or ` ::: `, dropping blanks and Google "* myContacts" system labels. */
function splitGroups(cell: string): string[] {
  return cell
    .split(/\s*:::\s*|\s*[,;]\s*/)
    .map((g) => g.trim())
    .filter((g) => g !== '' && !g.startsWith('*'));
}

const SENSITIVE_HEADER = /e-?mail|phone|mobile|address|birthday/i;

/** Optional extras used by the LinkedIn wrapper; the UI path uses the defaults. */
export interface CsvResultOptions {
  kind?: ImportKind;
  /** Header of a "connected on" date column (LinkedIn). */
  connectedOnColumn?: string;
}

/** Convert parsed rows (first row = headers) to people using a column mapping. */
export function csvToResult(
  rows: string[][],
  mapping: CsvMapping,
  source: string,
  options: CsvResultOptions = {},
): ImportResult {
  const headers = (rows[0] ?? []).map((h) => h.replace(/^﻿/, ''));
  const idx = (h?: string) => (h === undefined ? -1 : headers.indexOf(h));
  const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');

  const col = {
    name: idx(mapping.name),
    first: idx(mapping.firstName),
    last: idx(mapping.lastName),
    org: idx(mapping.org),
    role: idx(mapping.role),
    lastContact: idx(mapping.lastContact),
    status: idx(mapping.status),
    notes: idx(mapping.notes),
    url: idx(mapping.url),
    connectedOn: idx(options.connectedOnColumn),
    groups: mapping.groups.map(idx).filter((i) => i >= 0),
  };

  const people: ImportedPerson[] = [];
  const groupMembers = new Map<string, string[]>();
  let skipped = 0;

  for (const row of rows.slice(1)) {
    const raw = cell(row, col.name) || [cell(row, col.first), cell(row, col.last)].filter(Boolean).join(' ');
    if (!raw) {
      skipped++;
      continue;
    }
    const org = cell(row, col.org) || undefined;
    const role = cell(row, col.role) || undefined;
    const person = makePerson(raw, { org, role });

    const groups: string[] = [];
    for (const gi of col.groups) {
      for (const g of splitGroups(cell(row, gi))) if (!groups.includes(g)) groups.push(g);
    }
    person.groups = groups;

    const lastContact = parseLooseDate(cell(row, col.lastContact));
    if (lastContact) person.lastContact = lastContact;
    const connectedOn = parseLooseDate(cell(row, col.connectedOn));
    if (connectedOn) person.connectedOn = connectedOn;
    const status = cell(row, col.status);
    if (status) person.status = status;
    const notes = cell(row, col.notes);
    if (notes) person.notes = notes;
    const url = cell(row, col.url);
    if (url) person.url = url;

    people.push(person);
    for (const g of groups) {
      const members = groupMembers.get(g) ?? [];
      if (!members.includes(person.name)) members.push(person.name);
      groupMembers.set(g, members);
    }
  }

  const mapped = new Set<string>(
    [mapping.name, mapping.firstName, mapping.lastName, mapping.org, mapping.role, mapping.lastContact,
      mapping.status, mapping.notes, mapping.url, options.connectedOnColumn, ...mapping.groups]
      .filter((h): h is string => h !== undefined),
  );
  const dropped = headers.filter((h, i) => SENSITIVE_HEADER.test(h) && !mapped.has(h) && headers.indexOf(h) === i);

  const warnings: string[] = [];
  if (skipped > 0) warnings.push(`${skipped} ${skipped === 1 ? 'row' : 'rows'} had no name and ${skipped === 1 ? 'was' : 'were'} skipped`);

  return {
    kind: options.kind ?? 'csv',
    source,
    people,
    groups: [...groupMembers].map(([name, members]) => ({ name, members })),
    warnings,
    dropped,
  };
}
