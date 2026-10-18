// Shared shapes for the in-browser importers. Parsers are pure functions:
// text (or parsed JSON) in, ImportResult out. Nothing here touches storage or the network.

export type ImportKind = 'linkedin' | 'vcard' | 'csv' | 'whatsapp' | 'facebook' | 'instagram';

export interface ImportedPerson {
  /** Display name with tags stripped ("MAJ Alex Rivera 140" -> "Alex Rivera"). */
  name: string;
  /** The name exactly as it appeared in the source, before cleaning. */
  raw: string;
  org?: string;
  role?: string;
  /** Tag-like tokens found in the name, org or title ("140", "GSB'28", "YFC"). Rank excluded. */
  tags: string[];
  /** A military/organisational rank found in the name, if any ("MAJ"). */
  rank?: string;
  /** Group/label/category names this person belongs to in the source (vCard CATEGORIES, chat group). */
  groups: string[];
  /** YYYY-MM-DD of the last interaction the source knows about (a chat message, etc.). */
  lastContact?: string;
  /** YYYY-MM-DD the connection was made (LinkedIn "Connected On", Facebook friend timestamp). */
  connectedOn?: string;
  /** Mapped status text from a CRM-like CSV ("Met once", "Following up"), if a column was mapped. */
  status?: string;
  /** Short free-text notes the user chose to import (CSV only, when mapped). */
  notes?: string;
  /** Profile URL (LinkedIn, Instagram), kept because it identifies the person on that site. */
  url?: string;
}

export interface ImportResult {
  kind: ImportKind;
  /** Human label for the source, e.g. "LinkedIn connections" or "WhatsApp: Squad 12". */
  source: string;
  people: ImportedPerson[];
  /** Groups the source defines (a WhatsApp group chat, vCard categories), with member names (cleaned). */
  groups: { name: string; members: string[] }[];
  /** Non-fatal problems worth telling the user about ("12 rows had no name"). */
  warnings: string[];
  /** Field names that exist in the source but were deliberately NOT kept (phone, email, message text, address). */
  dropped: string[];
}

/** Column mapping for a generic CSV. Values are header names (exact), or undefined. */
export interface CsvMapping {
  name?: string;
  firstName?: string;
  lastName?: string;
  org?: string;
  role?: string;
  /** Columns whose values are group/context names. A cell may hold several, separated by , ; or ::: */
  groups: string[];
  lastContact?: string;
  status?: string;
  notes?: string;
  url?: string;
}

export type CsvPreset = 'linkedin' | 'google' | 'outlook' | 'notion' | 'generic';
