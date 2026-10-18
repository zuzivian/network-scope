import { describe, it, expect } from 'vitest';
import { parseCalendar } from './calendar';
import { importFile } from './index';

const ev = (title: string, people: string[], extra = '') => [
  'BEGIN:VEVENT', `SUMMARY:${title}`, 'DTSTART:20261001T170000Z', 'DESCRIPTION:Dial in 555-0100 secret agenda', 'LOCATION:Room 42',
  ...people, extra, 'END:VEVENT',
].filter(Boolean).join('\r\n');
const me = 'ORGANIZER;CN=Jordan Lee:mailto:jordan@school.edu';
const att = (cn: string, email: string, decl = false) => `ATTENDEE;CN="${cn}"${decl ? ';PARTSTAT=DECLINED' : ''}:mailto:${email}`;

const ICS = [
  'BEGIN:VCALENDAR',
  ev('Study group', [me, att('Ana Ruiz', 'ana@school.edu'), att('Ben Cho', 'ben.cho@bain.com')], 'RRULE:FREQ=WEEKLY'),
  ev('Coffee re: secret project', [me, att('Cy Dunn', 'cy.dunn@mckinsey.com')]),
  ev('Coffee', [me, 'ATTENDEE:mailto:dana.fox@gmail.com']),
  ev('All hands', [me, ...Array.from({ length: 20 }, (_, i) => att(`P ${i}`, `p${i}@co.com`))]),
  ev('Lunch', [me, att('Eve Ng', 'eve@co.com', true)]),
  ...Array.from({ length: 8 }, () => ev('1:1', [me, att('Ana Ruiz', 'ana@school.edu')])),
  'END:VCALENDAR',
].join('\r\n');

describe('parseCalendar', () => {
  const r = parseCalendar(ICS);

  it('finds the people you meet, without you, big meetings or declines', () => {
    expect(r.kind).toBe('calendar');
    expect(r.people.map((p) => p.name).sort()).toEqual(['Ana Ruiz', 'Ben Cho', 'Cy Dunn', 'Dana Fox']);
    expect(r.warnings).toContain('1 large meeting (over 15 people) skipped');
  });

  it('counts meetings, labels organisations from domains, groups recurring meetings', () => {
    const ana = r.people.find((p) => p.name === 'Ana Ruiz')!;
    expect(ana.meetings).toBe(9);
    expect(ana.org).toBe('School');
    expect(r.people.find((p) => p.name === 'Cy Dunn')!.org).toBe('Mckinsey');
    expect(r.people.find((p) => p.name === 'Dana Fox')!.org).toBeUndefined();
    expect(r.groups).toEqual([{ name: 'Study group', members: ['Ana Ruiz', 'Ben Cho'] }]);
  });

  it('keeps no addresses, one-off titles, descriptions, locations or dates', () => {
    const json = JSON.stringify(r);
    for (const s of ['@', 'secret', 'Room 42', '555', '2026', 'Coffee', 'Lunch', 'jordan']) expect(json).not.toContain(s);
  });

  it('is picked by importFile for .ics', () => {
    expect((importFile({ name: 'cal.ics', text: ICS }) as { kind: string }).kind).toBe('calendar');
  });
});
