// Calendar export (.ics) parser: who you meet with, and the recurring meetings you share.
// Kept: attendee names, an organisation label from their email domain, how many meetings you
// had together, and the titles of recurring meetings (as groups). Never kept: email addresses,
// one-off meeting titles, descriptions, locations, dial-in details or dates.

import { orgFromEmail } from './email';
import { makePerson } from './tags';
import type { ImportResult, ImportedPerson } from './types';

/** Meetings bigger than this are all-hands and lectures, not relationships. */
const MAX_ATTENDEES = 15;

interface Attendee { email: string; name?: string; declined: boolean }
interface Event { title: string; recurring: boolean; cancelled: boolean; people: Attendee[] }

/** RFC 5545 line unfolding: a line starting with a space or tab continues the previous one. */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/^﻿/, '').split(/\r\n|\n|\r/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

function param(head: string, key: string): string | undefined {
  const m = new RegExp(`;${key}=("[^"]*"|[^;:]*)`, 'i').exec(head);
  return m ? m[1].replace(/^"|"$/g, '').trim() : undefined;
}

const unescape = (v: string) => v.replace(/\\([,;\\nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? ' ' : c)).trim();

/** "jane.doe" -> "Jane Doe"; null when the local part doesn't look like a name. */
function nameFromLocal(email: string): string | null {
  const local = email.split('@')[0].replace(/\+.*$/, '');
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length < 2 || parts.some((p) => /\d/.test(p) || p.length < 2)) return null;
  return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

export function isCalendar(text: string): boolean {
  return /BEGIN:VCALENDAR/i.test(text.slice(0, 2000));
}

export function parseCalendar(text: string, source = 'Calendar'): ImportResult {
  const events: Event[] = [];
  let ev: Event | null = null;
  for (const line of unfold(text)) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:VEVENT')) { ev = { title: '', recurring: false, cancelled: false, people: [] }; continue; }
    if (upper.startsWith('END:VEVENT')) { if (ev) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const prop = head.split(';')[0].toUpperCase();
    const value = line.slice(colon + 1);
    if (prop === 'SUMMARY') ev.title = unescape(value);
    else if (prop === 'RRULE' || prop === 'RECURRENCE-ID') ev.recurring = true;
    else if (prop === 'STATUS' && /CANCELLED/i.test(value)) ev.cancelled = true;
    else if (prop === 'ATTENDEE' || prop === 'ORGANIZER') {
      const email = /mailto:([^\s;]+@[^\s;]+)/i.exec(value)?.[1]?.toLowerCase();
      if (!email) continue;
      const cn = param(head, 'CN');
      ev.people.push({
        email,
        name: cn && !cn.includes('@') ? unescape(cn) : undefined,
        declined: /^DECLINED$/i.test(param(head, 'PARTSTAT') ?? ''),
      });
    }
  }

  // The calendar's owner is whoever turns up in the most meetings: that's you, so leave them out.
  const seen = new Map<string, number>();
  for (const e of events) for (const a of new Set(e.people.map((p) => p.email))) seen.set(a, (seen.get(a) ?? 0) + 1);
  const me = [...seen].sort((a, b) => b[1] - a[1])[0]?.[0];

  // Titles that recur (a weekly study group, a standing 1:1 series) become groups.
  const titleCount = new Map<string, number>();
  for (const e of events) if (e.title) titleCount.set(e.title.toLowerCase(), (titleCount.get(e.title.toLowerCase()) ?? 0) + 1);

  const byEmail = new Map<string, { name: string; org?: string; meetings: number; groups: Set<string> }>();
  let big = 0, unnamed = 0;
  for (const e of events) {
    if (e.cancelled) continue;
    const others = [...new Map(e.people.filter((p) => p.email !== me && !p.declined).map((p) => [p.email, p])).values()];
    if (!others.length) continue;
    if (others.length + 1 > MAX_ATTENDEES) { big++; continue; }
    const series = e.title && others.length >= 2 && (e.recurring || (titleCount.get(e.title.toLowerCase()) ?? 0) >= 3)
      ? e.title.slice(0, 60) : undefined;
    for (const a of others) {
      const name = a.name ?? nameFromLocal(a.email);
      if (!name) { unnamed++; continue; }
      const rec = byEmail.get(a.email) ?? { name, org: orgFromEmail(a.email), meetings: 0, groups: new Set<string>() };
      rec.meetings++;
      if (series) rec.groups.add(series);
      byEmail.set(a.email, rec);
    }
  }

  const people: ImportedPerson[] = [];
  const groupMembers = new Map<string, string[]>();
  const byName = new Map<string, ImportedPerson>();
  for (const r of byEmail.values()) {
    // The same person from two addresses is one person.
    const prev = byName.get(r.name.toLowerCase());
    if (prev) {
      prev.meetings = (prev.meetings ?? 0) + r.meetings;
      prev.groups = [...new Set([...prev.groups, ...r.groups])];
      continue;
    }
    const person = makePerson(r.name, { org: r.org });
    person.groups = [...r.groups];
    person.meetings = r.meetings;
    byName.set(r.name.toLowerCase(), person);
    people.push(person);
  }
  for (const p of people) for (const g of p.groups) groupMembers.set(g, [...(groupMembers.get(g) ?? []), p.name]);

  const warnings: string[] = [];
  if (big) warnings.push(`${big} large meeting${big === 1 ? '' : 's'} (over ${MAX_ATTENDEES} people) skipped`);
  if (unnamed) warnings.push(`${unnamed} attendee${unnamed === 1 ? '' : 's'} without a readable name skipped`);
  return {
    kind: 'calendar',
    source,
    people,
    groups: [...groupMembers].map(([name, members]) => ({ name, members })),
    warnings,
    dropped: ['email addresses', 'one-off meeting titles', 'descriptions', 'locations', 'dates'],
  };
}
