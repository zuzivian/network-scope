import { describe, it, expect } from 'vitest';
import { parseWhatsAppChat } from './whatsapp';

const LRM = '‎';

const IOS = [
  `${LRM}[13/10/2026, 21:04:11] Alex Moreno: Secret plan about the thing`,
  `${LRM}[13/10/2026, 21:04:12] ${LRM}Messages and calls are end-to-end encrypted. No one outside of this chat can read them.`,
  '[14/10/2026, 9:04:11 PM] Sam Lee: second line starts here',
  'and this continuation line says something private',
  '[15/10/2026, 08:00:00] Alex Moreno: later message',
  '[10/10/2026, 08:00:00] Alex Moreno: earlier message',
  '[16/10/2026, 10:00:00] ‪+1 (650) 555-0100‬: who is this',
  '[16/10/2026, 10:01:00] +65 9123 4567: hello there',
  '[16/10/2026, 10:02:00] Alex Moreno added Priya Nair',
  '[16/10/2026, 10:03:00] Alex Moreno: ‎image omitted',
].join('\n');

describe('parseWhatsAppChat iOS', () => {
  const r = parseWhatsAppChat(IOS, 'WhatsApp Chat - Squad 12.txt');

  it('collects senders and keeps no timestamps', () => {
    expect(r.kind).toBe('whatsapp');
    expect(r.source).toBe('WhatsApp: Squad 12');
    expect(r.people.map((p) => p.name)).toEqual(expect.arrayContaining(['Alex Moreno', 'Sam Lee']));
    expect(JSON.stringify(r)).not.toMatch(/2026/);
  });

  it('adds a group with all senders and added members', () => {
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].name).toBe('Squad 12');
    expect(r.groups[0].members).toEqual(expect.arrayContaining(['Alex Moreno', 'Sam Lee', 'Priya Nair']));
    expect(r.people.every((p) => p.groups.includes('Squad 12'))).toBe(true);
  });

  it('skips phone-number senders and counts them', () => {
    expect(r.warnings).toContain('2 unsaved numbers skipped');
    expect(JSON.stringify(r)).not.toMatch(/555|9123/);
    expect(r.dropped).toEqual(['message text']);
  });

  it('ignores system lines and continuation lines and never stores message text', () => {
    const json = JSON.stringify(r);
    for (const s of ['Secret plan', 'end-to-end', 'private', 'later message', 'image omitted', 'who is this']) {
      expect(json).not.toContain(s);
    }
    expect(r.people.map((p) => p.name).sort()).toEqual(['Alex Moreno', 'Priya Nair', 'Sam Lee']);
  });
});

describe('parseWhatsAppChat Android', () => {
  it('parses Android lines, 24h and 12h clocks', () => {
    const text = [
      '13/10/2026, 21:04 - Messages and calls are end-to-end encrypted.',
      '13/10/2026, 21:04 - Alex Moreno: hi there',
      '14/10/2026, 9:04 pm - Alex Rivera: yo',
    ].join('\n');
    const r = parseWhatsAppChat(text, 'WhatsApp Chat with Alex Rivera.txt');
    expect(r.source).toBe('WhatsApp: Alex Rivera');
    expect(r.groups).toEqual([]);
    expect(r.people.map((p) => p.name).sort()).toEqual(['Alex Moreno', 'Alex Rivera']);
    expect(r.people.find((p) => p.name === 'Alex Moreno')?.groups).toEqual([]);
  });

  it('reads US-style (M/D) lines', () => {
    const text = ['10/13/26, 9:04 PM - Alex Moreno: hi', '10/01/26, 9:04 AM - Sam Lee: yo'].join('\n');
    const r = parseWhatsAppChat(text, 'WhatsApp Chat with Sam Lee.txt');
    expect(r.people.map((p) => p.name).sort()).toEqual(['Alex Moreno', 'Sam Lee']);
  });

  it('reads day-first (D/M) lines', () => {
    const a = parseWhatsAppChat('13/10/2026, 21:04 - A One: x\n', 'WhatsApp Chat with A One.txt');
    expect(a.people[0].name).toBe('A One');
    const b = parseWhatsAppChat('03/04/2026, 21:04 - A One: x\n', 'WhatsApp Chat with A One.txt');
    expect(b.people[0].name).toBe('A One');
  });

  it('treats chats with more than two senders as groups, and zip _chat.txt as unnamed', () => {
    const text = ['01/02/2026, 10:00 - Ann Wu: a', '01/02/2026, 10:01 - Bo Li: b', '01/02/2026, 10:02 - Cy Do: c'].join('\n');
    const r = parseWhatsAppChat(text, '_chat.txt');
    expect(r.source).toBe('WhatsApp chat');
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].members).toHaveLength(3);
  });

  it('does not make a group out of a one-to-one "WhatsApp Chat - Name" file', () => {
    const text = ['01/02/2026, 10:00 - Ann Wu: a', '01/02/2026, 10:01 - Me Myself: b'].join('\n');
    expect(parseWhatsAppChat(text, 'WhatsApp Chat - Ann Wu.txt').groups).toEqual([]);
  });

  it('cleans tags from sender names', () => {
    const r = parseWhatsAppChat('01/02/2026, 10:00 - MAJ Alex Rivera 140: hey\n', 'WhatsApp Chat with x.txt');
    expect(r.people[0]).toMatchObject({ name: 'Alex Rivera', rank: 'MAJ', tags: ['140'] });
  });

  it('does not mistake system lines containing a colon for senders', () => {
    const text = [
      '01/02/2026, 10:00 - Ann Wu changed the subject from "Old: name" to "New"',
      '01/02/2026, 10:01 - Ann Wu: hi',
    ].join('\n');
    const r = parseWhatsAppChat(text, 'WhatsApp Chat with Ann Wu.txt');
    expect(r.people.map((p) => p.name)).toEqual(['Ann Wu']);
  });
});
