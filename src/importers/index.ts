// Entry point for the importers: dispatch a dropped file to the right parser.

import { detectPreset, parseCSV } from './csv';
import { isLinkedInCsv, parseLinkedInConnections } from './linkedin';
import { detectJson, parseFacebookFriends, parseInstagram } from './social';
import { parseVCards } from './vcard';
import { parseWhatsAppChat } from './whatsapp';
import type { CsvMapping, CsvPreset, ImportResult } from './types';

export * from './csv';
export * from './linkedin';
export * from './social';
export * from './tags';
export * from './vcard';
export * from './whatsapp';
export type * from './types';

/** A generic CSV needs the user to confirm the column mapping, then call csvToResult. */
export interface NeedsMapping {
  needsMapping: true;
  headers: string[];
  rows: string[][];
  preset: CsvPreset;
  mapping: CsvMapping;
}

/** Import a dropped file by extension and content. Throws an Error with a friendly message if unsupported. */
export function importFile(file: { name: string; text: string }): ImportResult | NeedsMapping {
  const ext = /\.([^./\\]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? '';

  if (ext === 'vcf' || ext === 'vcard') return parseVCards(file.text);

  if (ext === 'csv' || ext === 'tsv') {
    if (isLinkedInCsv(file.text)) return parseLinkedInConnections(file.text);
    const rows = parseCSV(file.text);
    if (rows.length === 0) throw new Error('That CSV file looks empty.');
    const { preset, mapping } = detectPreset(rows[0]);
    return { needsMapping: true, headers: rows[0], rows, preset, mapping };
  }

  if (ext === 'txt') return parseWhatsAppChat(file.text, file.name);

  if (ext === 'json') {
    let json: unknown;
    try {
      json = JSON.parse(file.text);
    } catch {
      throw new Error("That file isn't valid JSON. Use the original file from Facebook or Instagram's data download.");
    }
    const kind = detectJson(json, file.name);
    if (kind === 'facebook') return parseFacebookFriends(json);
    if (kind === 'instagram') return parseInstagram(json, file.name);
    throw new Error(
      "We couldn't recognise this JSON file. Try Facebook's friends file (your_friends.json) or Instagram's followers_1.json / following.json.",
    );
  }

  throw new Error(`Unsupported file type${ext ? ` ".${ext}"` : ''}. Drop a .vcf, .csv, WhatsApp .txt or Facebook/Instagram .json file.`);
}
