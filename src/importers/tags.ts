// Context-tag extraction for contact names. People often save contacts as
// "MAJ Alex Rivera 140" or "Owen Hart (YFC GRP/ABC)"; this splits the real name
// from rank and tag-like tokens. Pure string work, no I/O.

import type { ImportedPerson } from './types';

/** Military/civilian ranks recognised in a name (compared upper-case). */
export const RANKS: ReadonlySet<string> = new Set([
  'REC', 'PTE', 'LCP', 'CPL', 'CFC', '3SG', '2SG', '1SG', 'SSG', 'MSG',
  '3WO', '2WO', '1WO', 'MWO', 'SWO', 'CWO', 'OCT', '2LT', 'LTA', 'CPT',
  'MAJ', 'LTC', 'SLTC', 'COL', 'BG', 'MG', 'LG',
  'ME1', 'ME1T', 'ME2', 'ME3', 'ME4', 'ME5', 'ME6', 'ME7', 'ME8',
  'DR', 'PROF', 'CAPT', 'LT', 'SGT', 'GEN',
]);

/** Ranks that double as ordinary words/titles; they need two other name words to count. */
const TITLE_RANKS: ReadonlySet<string> = new Set(['DR', 'PROF', 'GEN']);

/** All-caps acronyms that are tags even when they are the last word of a name. */
/**
 * Surnames people often write in capitals ("Shaun TAN", "Mei LI"). An all-caps last word
 * is read as a surname only if it's here; any other all-caps word is a tag ("Ravi YFC").
 * Deliberately generic: common surnames worldwide, nothing about any one user.
 */
export const COMMON_SURNAMES: ReadonlySet<string> = new Set([
  'TAN', 'LIM', 'LEE', 'NG', 'ONG', 'WONG', 'CHAN', 'CHEN', 'CHUA', 'GOH', 'TEO', 'KOH', 'TAY', 'YEO', 'LOW', 'SIM', 'OH', 'HO', 'LAU', 'LOH', 'TOH', 'SEAH', 'FOO', 'QUEK', 'CHONG', 'CHIA', 'LEONG', 'YAP', 'KWOK', 'LIEW', 'PHUA', 'SNG',
  'WANG', 'LI', 'ZHANG', 'LIU', 'YANG', 'HUANG', 'ZHAO', 'WU', 'ZHOU', 'XU', 'SUN', 'MA', 'ZHU', 'HU', 'GUO', 'HE', 'LIN', 'LUO', 'GAO', 'XIE', 'TANG', 'HAN', 'FENG', 'DENG', 'CAO', 'PENG', 'ZENG', 'XIAO', 'TIAN', 'DONG', 'PAN', 'YUAN', 'CAI', 'JIANG', 'YU', 'DU', 'YE', 'CHENG', 'WEI', 'SU', 'LU', 'DING', 'REN', 'SHEN', 'YAO', 'JIN', 'WEI',
  'KIM', 'PARK', 'CHOI', 'JUNG', 'KANG', 'CHO', 'YOON', 'JANG', 'LIM', 'SHIN', 'KWON', 'HWANG', 'AHN', 'SONG', 'HONG', 'NAM',
  'NGUYEN', 'TRAN', 'LE', 'PHAM', 'HOANG', 'VU', 'DANG', 'BUI', 'DO', 'NGO', 'DUONG', 'LY',
  'SATO', 'SUZUKI', 'TAKAHASHI', 'TANAKA', 'WATANABE', 'ITO', 'YAMAMOTO', 'NAKAMURA', 'KOBAYASHI', 'KATO',
  'SINGH', 'KUMAR', 'SHARMA', 'PATEL', 'GUPTA', 'KHAN', 'SHAH', 'RAO', 'REDDY', 'IYER', 'NAIR', 'DAS', 'ALI', 'AHMAD', 'RAHMAN', 'BIN', 'BINTE',
  'SMITH', 'JONES', 'BROWN', 'JOHNSON', 'WILLIAMS', 'MILLER', 'DAVIS', 'GARCIA', 'RODRIGUEZ', 'MARTINEZ', 'LOPEZ', 'GONZALEZ', 'WILSON', 'ANDERSON', 'TAYLOR', 'THOMAS', 'MOORE', 'MARTIN', 'JACKSON', 'WHITE', 'HARRIS', 'CLARK', 'LEWIS', 'ROBINSON', 'WALKER', 'YOUNG', 'ALLEN', 'KING', 'WRIGHT', 'SCOTT', 'HILL', 'GREEN', 'ADAMS', 'BAKER', 'NELSON', 'CARTER', 'MITCHELL', 'ROBERTS', 'CAMPBELL', 'EVANS', 'MURPHY', 'COOK', 'MORGAN', 'BELL', 'COOPER', 'WARD', 'COX', 'GRAY', 'REED', 'BAILEY', 'KELLY', 'HOWARD', 'ROSS', 'FOSTER', 'GRAHAM', 'SANCHEZ', 'PEREZ', 'TORRES', 'RAMIREZ', 'FLORES', 'RIVERA', 'GOMEZ', 'DIAZ', 'CRUZ', 'REYES', 'MORALES', 'ORTIZ', 'SILVA', 'SANTOS', 'COSTA', 'ROSSI', 'MULLER', 'SCHMIDT', 'SCHNEIDER', 'FISCHER', 'WEBER', 'MEYER', 'MARTIN', 'BERNARD', 'DUBOIS', 'LEROY', 'MOREAU', 'COHEN', 'LEVI',
]);

/** Capitalised words that are job titles, degrees or suffixes, not context labels. */
export const NOT_TAGS: ReadonlySet<string> = new Set([
  'CEO', 'CTO', 'CFO', 'COO', 'CMO', 'CPO', 'CRO', 'CIO', 'CISO', 'VP', 'SVP', 'EVP', 'AVP', 'GM', 'MD', 'PM', 'TPM', 'PMM', 'APM', 'SDE', 'SWE',
  'HR', 'IT', 'QA', 'UX', 'UI', 'BD', 'ML', 'AI', 'R&D', 'PHD', 'MBA', 'MS', 'BS', 'BA', 'CPA', 'CFA', 'ESQ', 'JR', 'SR', 'II', 'III', 'IV', 'PA', 'EA',
]);

const FORCED = '\u0001'; // marks tokens that came from a (parenthesised group)
const CLASS_YEAR = /^[A-Za-z]{2,}'\d{2}$/; // GSB'28, MSx'27, Partner'28
const HYPHEN_CAPS = /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/; // ABC-XYZ
const CODE_WORD = /^(?:bravo|alpha|charlie)$/i;
const ALL_CAPS = /^\p{Lu}{2,}$/u;

interface Token {
  text: string;
  forced: boolean;
}

interface Item {
  text: string;
  kind: 'tag' | 'caps' | 'word';
}

/** Strip leading/trailing characters that are neither letters nor digits. */
function trimPunct(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** Tokens that are unambiguously tags (as opposed to possibly part of a name). */
function isDefiniteTag(t: string): boolean {
  return (
    CLASS_YEAR.test(t) ||
    (t.length >= 2 && /\d/.test(t)) ||
    CODE_WORD.test(t) ||
    HYPHEN_CAPS.test(t)
  );
}

function titleCase(w: string): string {
  return w.charAt(0) + w.slice(1).toLowerCase();
}

/** Normalise, expand parenthesised groups and split into tokens. */
function tokenise(raw: string, parensAreTags: boolean): Token[] {
  let s = raw
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[‎‏‪-‮]/g, '')
    .replace(/_/g, ' ');
  s = s.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    if (!parensAreTags) return ` ${inner} `;
    const parts = inner.split(/[\s/,;]+/).map(trimPunct).filter(Boolean);
    return ` ${parts.map((p) => FORCED + p).join(' ')} `;
  });
  const out: Token[] = [];
  for (const piece of s.split(/\s+/)) {
    if (!piece) continue;
    if (piece.startsWith(FORCED)) out.push({ text: piece.slice(1), forced: true });
    else {
      const text = trimPunct(piece);
      if (text) out.push({ text, forced: false });
    }
  }
  return out;
}

/** Turn one non-forced token into items (a "140/142" token yields two tags). */
function classify(text: string): Item[] {
  if (text.includes('/')) {
    const parts = text.split('/').map(trimPunct).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => isDefiniteTag(p) || ALL_CAPS.test(p))) {
      return parts.map((p) => ({ text: p, kind: 'tag' as const }));
    }
  }
  if (isDefiniteTag(text)) return [{ text, kind: 'tag' }];
  if (ALL_CAPS.test(text)) return [{ text, kind: 'caps' }];
  return [{ text, kind: 'word' }];
}

function dedupeAdjacent(words: string[]): string[] {
  return words.filter((w, i) => i === 0 || w.toLowerCase() !== words[i - 1].toLowerCase());
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

/** One pass over the tokens; returns null when the name would be empty or the rank is implausible. */
function analyse(toks: Token[], allowRank: boolean): { name: string; tags: string[]; rank?: string } | null {
  const rankIdx = allowRank ? toks.findIndex((t) => !t.forced && RANKS.has(t.text.toUpperCase())) : -1;
  const items: Item[] = [];
  toks.forEach((t, i) => {
    if (i === rankIdx) return;
    if (t.forced) items.push({ text: t.text, kind: 'tag' });
    else items.push(...classify(t.text));
  });

  const nameItems = items.filter((it) => it.kind !== 'tag');
  if (nameItems.length === 0) return null;

  // All-caps words: a shouted name ("ALEX MORENO") is a name; otherwise only a last word
  // that is a common surname ("Shaun TAN", "Mei LI") is a name; the rest are tags ("Ravi YFC").
  const hasWord = nameItems.some((it) => it.kind === 'word');
  const last = nameItems[nameItems.length - 1];
  for (const it of nameItems) {
    if (it.kind !== 'caps') continue;
    if (!hasWord || (it === last && COMMON_SURNAMES.has(it.text))) {
      it.kind = 'word';
      it.text = titleCase(it.text);
    } else it.kind = 'tag';
  }

  const words = items.filter((it) => it.kind === 'word').map((it) => it.text);
  let rank: string | undefined;
  if (rankIdx >= 0) {
    rank = toks[rankIdx].text.toUpperCase();
    if (words.length < (TITLE_RANKS.has(rank) ? 2 : 1)) return null;
  }
  if (words.length === 0) return null;

  const result: { name: string; tags: string[]; rank?: string } = {
    name: dedupeAdjacent(words).join(' '),
    tags: unique(items.filter((it) => it.kind === 'tag').map((it) => it.text)),
  };
  if (rank) result.rank = rank;
  return result;
}

/** Split a saved contact name into a clean name, context tags and an optional rank. */
export function extractTags(raw: string): { name: string; tags: string[]; rank?: string } {
  const toks = tokenise(raw, true);
  const result = analyse(toks, true) ?? analyse(toks, false);
  if (result) return result;
  // Nothing but tags/rank: keep the original words as the name.
  const words = dedupeAdjacent(toks.map((t) => t.text));
  return { name: words.join(' ') || raw.trim(), tags: [] };
}

/** Tags found in free text such as an organisation or job title (parentheses are not special). */
export function tagsFromText(text: string): string[] {
  // Org/title text isn't a name, so every all-caps word or code in it is a tag ("DSTA", "AD ABC XYZ").
  const toks = tokenise(text, false);
  return unique(toks.flatMap((t) => (t.forced ? [t.text] : classify(t.text).filter((it) => it.kind === 'tag' || it.kind === 'caps').map((it) => it.text))))
    .filter((t) => !NOT_TAGS.has(t.toUpperCase()));
}

/**
 * Build an ImportedPerson from a raw contact name plus optional org/role.
 * Name tags and org/role tags are merged; org and role strings are kept as-is.
 */
export function makePerson(raw: string, extra: { org?: string; role?: string } = {}): ImportedPerson {
  const { name, tags, rank } = extractTags(raw);
  const allTags = [...tags];
  for (const text of [extra.org, extra.role]) {
    if (!text) continue;
    for (const t of tagsFromText(text)) if (!allTags.includes(t)) allTags.push(t);
  }
  const person: ImportedPerson = { name, raw, tags: allTags, groups: [] };
  if (rank) person.rank = rank;
  if (extra.org) person.org = extra.org;
  if (extra.role) person.role = extra.role;
  return person;
}
