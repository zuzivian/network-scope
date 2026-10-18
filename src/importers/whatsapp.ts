// WhatsApp exported chat (.txt) parser. Keeps only who spoke (and, for a group, the group).
// Message text and timestamps are read to find sender names and then discarded;
// unsaved phone numbers are counted, never stored.

import { makePerson } from './tags';
import type { ImportResult, ImportedPerson } from './types';

// iOS: "[13/10/2026, 21:04:11] Name: msg"   Android: "13/10/2026, 21:04 - Name: msg"
const HEADER =
  /^\[?\d{1,2}[/.]\d{1,2}[/.]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?(?:\]\s*|\s+-\s+)(.*)$/;

/** Invisible direction marks WhatsApp sprinkles around names and at line starts. */
const INVISIBLES = /[‎‏‪-‮]/g;
const SYSTEM_VERB = / (?:changed|added|removed|created|deleted|updated|turned|pinned) /i;

function isPhoneNumber(s: string): boolean {
  return /^[+\d\s().-]+$/.test(s) && (s.match(/\d/g)?.length ?? 0) >= 7;
}

function cleanSender(s: string): string {
  return s.replace(INVISIBLES, '').replace(/^~\s*/, '').trim();
}

/** Member names mentioned by "X added Y", "X joined using this group's invite link". */
function membersFromSystemLine(text: string): string[] {
  const t = text.replace(INVISIBLES, '').trim().replace(/\.$/, '');
  let m = /^(.+?) added (.+)$/.exec(t);
  if (m && !/^(?:a|an|the|this)\s/i.test(m[2])) {
    return [m[1], ...m[2].split(/,\s*|\s+and\s+/)];
  }
  m = /^(.+?) (?:was added|joined using this group's invite link|joined using a group link)$/.exec(t);
  if (m) return [m[1]];
  return [];
}

/** Work out the chat name and whether the filename marks a group. */
function describeFile(fileName: string): { chatName?: string; fileSaysGroup: boolean } {
  const base = (fileName.split(/[\\/]/).pop() ?? fileName)
    .replace(/\.txt$/i, '')
    .replace(/\s*\(\d+\)$/, '')
    .trim();
  if (/^_chat$/i.test(base)) return { fileSaysGroup: false };
  let m = /^WhatsApp Chat with (.+)$/i.exec(base);
  if (m) return { chatName: m[1].trim(), fileSaysGroup: false };
  m = /^WhatsApp Chat - (.+)$/i.exec(base);
  if (m) return { chatName: m[1].trim(), fileSaysGroup: true };
  return { chatName: base || undefined, fileSaysGroup: false };
}

/** Parse an exported WhatsApp chat. `fileName` names the chat ("WhatsApp Chat - Squad 12.txt"). */
export function parseWhatsAppChat(text: string, fileName: string): ImportResult {
  const entries: string[] = [];
  const systemMembers: string[] = [];

  for (const rawLine of text.replace(/^﻿/, '').split(/\r\n|\n|\r/)) {
    const m = HEADER.exec(rawLine.replace(INVISIBLES, ''));
    if (!m) continue; // continuation of the previous message
    const rest = m[1];
    const colon = rest.indexOf(': ');
    const sender = colon > 0 ? cleanSender(rest.slice(0, colon)) : '';
    if (sender && sender.length <= 64 && !/["“”]/.test(sender) && !SYSTEM_VERB.test(` ${sender} `)) {
      entries.push(sender);
    } else {
      systemMembers.push(...membersFromSystemLine(rest));
    }
  }

  const unsaved = new Set<string>();
  const senders = new Set<string>();
  for (const sender of entries) {
    senders.add(sender);
    if (isPhoneNumber(sender)) unsaved.add(sender);
  }

  const { chatName, fileSaysGroup } = describeFile(fileName);
  const looksOneToOne =
    fileSaysGroup && senders.size <= 2 && !!chatName && [...senders].some((s) => s.toLowerCase() === chatName.toLowerCase());
  const isGroup = senders.size > 2 || (fileSaysGroup && !looksOneToOne);
  const groupName = chatName ?? 'WhatsApp group';

  const people: ImportedPerson[] = [];
  const seen = new Set<string>();
  const addPerson = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const person = makePerson(name);
    if (isGroup) person.groups = [groupName];
    people.push(person);
  };
  for (const name of senders) if (!isPhoneNumber(name)) addPerson(name);

  if (isGroup) {
    for (const raw of systemMembers) {
      const name = cleanSender(raw);
      if (!name || /^you$/i.test(name)) continue;
      if (isPhoneNumber(name)) unsaved.add(name);
      else addPerson(name);
    }
  }

  const warnings: string[] = [];
  if (unsaved.size > 0) warnings.push(`${unsaved.size} unsaved ${unsaved.size === 1 ? 'number' : 'numbers'} skipped`);
  if (entries.length === 0) warnings.push('No WhatsApp messages found in this file');
  if (isGroup && !chatName) warnings.push('Chat name unknown (zip export); the group is called "WhatsApp group"');

  return {
    kind: 'whatsapp',
    source: chatName ? `WhatsApp: ${chatName}` : 'WhatsApp chat',
    people,
    groups: isGroup ? [{ name: groupName, members: people.map((p) => p.name) }] : [],
    warnings,
    dropped: ['message text'],
  };
}
