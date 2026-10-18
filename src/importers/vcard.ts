// vCard (.vcf) parser for 2.1, 3.0 and 4.0. Reads name, org, title and categories only;
// phone, email, address, birthday, notes and photos are skipped (their property names are
// reported in `dropped`).

import { orgFromEmail } from './email';
import { makePerson } from './tags';
import type { ImportResult, ImportedPerson } from './types';

const DROPPED_PROPS = new Set(['TEL', 'EMAIL', 'ADR', 'BDAY', 'NOTE', 'PHOTO', 'X-SOCIALPROFILE']);

/** Join folded lines (leading space/tab) and quoted-printable soft breaks (trailing `=`). */
function unfold(text: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  const isQP = (l: string) => /^[^:]*QUOTED-PRINTABLE/i.test(l);
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if (cur !== null && isQP(cur) && cur.endsWith('=')) {
      cur = cur.slice(0, -1) + raw;
    } else if (cur !== null && /^[ \t]/.test(raw)) {
      cur += raw.slice(1);
    } else {
      if (cur !== null) out.push(cur);
      cur = raw;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** Decode `=XX` sequences as bytes in the given charset (falls back to UTF-8). */
function decodeQuotedPrintable(value: string, charset: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (const piece of value.split(/(=[0-9A-Fa-f]{2})/)) {
    if (/^=[0-9A-Fa-f]{2}$/.test(piece)) bytes.push(parseInt(piece.slice(1), 16));
    else bytes.push(...encoder.encode(piece));
  }
  const data = new Uint8Array(bytes);
  try {
    return new TextDecoder(charset).decode(data);
  } catch {
    return new TextDecoder('utf-8').decode(data);
  }
}

/** Split on an unescaped separator, keeping backslash escapes intact for later unescaping. */
function splitUnescaped(v: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '\\' && i + 1 < v.length) {
      cur += c + v[i + 1];
      i++;
    } else if (c === sep) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Resolve `\,` `\;` `\\` and `\n` (newlines become spaces: these are names, not notes). */
function unescapeValue(v: string): string {
  return v.replace(/\\([nN,;\\])/g, (_m, ch: string) => (ch === 'n' || ch === 'N' ? ' ' : ch)).trim();
}

interface Card {
  fn?: string;
  n?: string[];
  org?: string;
  /** Organisation from an email domain, used only when the card has no ORG. */
  emailOrg?: string;
  title?: string;
  categories: string[];
}

/** Parse every BEGIN:VCARD ... END:VCARD block into people. */
export function parseVCards(text: string): ImportResult {
  const lines = unfold(text.replace(/^﻿/, ''));
  const dropped: string[] = [];
  const people: ImportedPerson[] = [];
  const groupMembers = new Map<string, string[]>();
  let skipped = 0;
  let card: Card | null = null;

  const finish = (c: Card) => {
    const given = c.n ? [c.n[1], c.n[2], c.n[0]].filter(Boolean).join(' ') : '';
    const raw = (c.fn || given).trim();
    if (!raw) {
      skipped++;
      return;
    }
    const person = makePerson(raw, { org: c.org || c.emailOrg || undefined, role: c.title || undefined });
    person.groups = [...new Set(c.categories)];
    people.push(person);
    for (const g of person.groups) {
      const members = groupMembers.get(g) ?? [];
      if (!members.includes(person.name)) members.push(person.name);
      groupMembers.set(g, members);
    }
  };

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VCARD') {
      card = { categories: [] };
      continue;
    }
    if (upper === 'END:VCARD') {
      if (card) finish(card);
      card = null;
      continue;
    }
    if (!card) continue;

    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [head, ...params] = line.slice(0, colon).split(';');
    const prop = head.replace(/^.*\./, '').trim().toUpperCase(); // drop "item1." group prefix

    if (DROPPED_PROPS.has(prop)) {
      if (!dropped.includes(prop)) dropped.push(prop);
      if (prop === 'EMAIL') card.emailOrg ??= orgFromEmail(line.slice(colon + 1));
      continue;
    }
    if (!['FN', 'N', 'ORG', 'TITLE', 'CATEGORIES'].includes(prop)) continue;

    let value = line.slice(colon + 1);
    const upperParams = params.map((p) => p.trim().toUpperCase());
    if (upperParams.some((p) => p === 'QUOTED-PRINTABLE' || p === 'ENCODING=QUOTED-PRINTABLE')) {
      const charset = params.map((p) => /^CHARSET=(.+)$/i.exec(p.trim())?.[1]).find(Boolean) ?? 'utf-8';
      value = decodeQuotedPrintable(value, charset);
    }

    switch (prop) {
      case 'FN':
        card.fn = unescapeValue(value);
        break;
      case 'N':
        card.n = splitUnescaped(value, ';').map(unescapeValue);
        break;
      case 'ORG':
        card.org = unescapeValue(splitUnescaped(value, ';')[0]);
        break;
      case 'TITLE':
        card.title = unescapeValue(value);
        break;
      case 'CATEGORIES':
        for (const c of splitUnescaped(value, ',')) {
          const g = unescapeValue(c);
          if (g) card.categories.push(g);
        }
        break;
    }
  }

  const warnings: string[] = [];
  if (skipped > 0) warnings.push(`${skipped} ${skipped === 1 ? 'card' : 'cards'} had no name and ${skipped === 1 ? 'was' : 'were'} skipped`);

  return {
    kind: 'vcard',
    source: 'Contacts (vCard)',
    people,
    groups: [...groupMembers].map(([name, members]) => ({ name, members })),
    warnings,
    dropped,
  };
}
