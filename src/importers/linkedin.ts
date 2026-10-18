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
