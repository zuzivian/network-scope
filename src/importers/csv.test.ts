import { describe, it, expect } from 'vitest';
import { csvToResult, detectPreset, parseCSV, parseLooseDate } from './csv';

describe('parseCSV', () => {
  it('handles quotes, escaped quotes, commas and newlines inside quotes', () => {
    const rows = parseCSV('a,b,c\n"x, y","He said ""hi""","line1\nline2"\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['x, y', 'He said "hi"', 'line1\nline2']]);
  });

  it('handles CRLF, BOM and trailing blank lines', () => {
    expect(parseCSV('﻿a,b\r\n1,2\r\n\r\n\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps empty cells', () => {
    expect(parseCSV('a,b,c\n1,,3')).toEqual([['a', 'b', 'c'], ['1', '', '3']]);
  });

  it('detects semicolon and tab delimiters', () => {
    expect(parseCSV('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCSV('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('does not switch delimiter when commas are present', () => {
    expect(parseCSV('a,b;c\n1,2;3')).toEqual([['a', 'b;c'], ['1', '2;3']]);
  });
});

describe('parseLooseDate', () => {
  it.each([
    ['2026-10-01', '2026-10-01'],
    ['2026-10-01T12:30:00Z', '2026-10-01'],
    ['October 1, 2026', '2026-10-01'],
    ['Oct 1, 2026', '2026-10-01'],
    ['1 Oct 2026', '2026-10-01'],
    ['01 Oct 2026', '2026-10-01'],
    ['10/01/2026', '2026-10-01'],
    ['13/01/2026', '2026-01-13'],
    ['nonsense', undefined],
    ['', undefined],
    ['31 Feb 2026', undefined],
    ['13/14/2026', undefined],
  ])('%s -> %s', (input, expected) => {
    expect(parseLooseDate(input)).toBe(expected);
  });
});

describe('detectPreset', () => {
  it('linkedin', () => {
    const d = detectPreset(['First Name', 'Last Name', 'URL', 'Email Address', 'Company', 'Position', 'Connected On']);
    expect(d.preset).toBe('linkedin');
    expect(d.mapping).toMatchObject({ firstName: 'First Name', lastName: 'Last Name', org: 'Company', role: 'Position', url: 'URL', groups: [] });
  });

  it('google (both header styles)', () => {
    const a = detectPreset(['First Name', 'Middle Name', 'Last Name', 'Organization Name', 'Organization Title', 'Labels', 'E-mail 1 - Value']);
    expect(a.preset).toBe('google');
    expect(a.mapping).toMatchObject({ org: 'Organization Name', role: 'Organization Title', groups: ['Labels'] });
    const b = detectPreset(['First Name', 'Last Name', 'Organization 1 - Name', 'Organization 1 - Title', 'Labels']);
    expect(b.mapping).toMatchObject({ org: 'Organization 1 - Name', role: 'Organization 1 - Title' });
  });

  it('outlook', () => {
    const d = detectPreset(['First Name', 'Last Name', 'Company', 'Job Title', 'Categories', 'E-mail Address']);
    expect(d.preset).toBe('outlook');
    expect(d.mapping).toMatchObject({ org: 'Company', role: 'Job Title', groups: ['Categories'] });
  });

  it('notion', () => {
    const d = detectPreset(['Name', 'Status', 'Tags', 'Where Met', 'Last Touchpoint', 'Company', 'Role']);
    expect(d.preset).toBe('notion');
    expect(d.mapping).toMatchObject({
      name: 'Name',
      status: 'Status',
      org: 'Company',
      role: 'Role',
      lastContact: 'Last Touchpoint',
      groups: ['Tags', 'Where Met'],
    });
  });

  it('generic', () => {
    const d = detectPreset(['Full Name', 'Employer', 'Job Title', 'Circle', 'Last Seen', 'Mobile']);
    expect(d.preset).toBe('generic');
    expect(d.mapping).toMatchObject({ name: 'Full Name', org: 'Employer', role: 'Job Title', groups: ['Circle'], lastContact: 'Last Seen' });
  });
});

describe('csvToResult', () => {
  it('builds people, groups and tags, and never copies contact details', () => {
    const rows = parseCSV(
      [
        'First Name,Last Name,Organization Name,Organization Title,Labels,E-mail 1 - Value,Phone 1 - Value',
        'Alex,Rivera 140,DSTA,"Engineer",* myContacts ::: Family ::: Work,alex@example.com,+65 9123 4567',
        'Ava,Stone,Acme,,* starred,ava@example.com,',
        ',,,,,x@example.com,',
      ].join('\n'),
    );
    const { mapping } = detectPreset(rows[0]);
    const r = csvToResult(rows, mapping, 'Google Contacts');
    expect(r.kind).toBe('csv');
    expect(r.people).toHaveLength(2);
    expect(r.people[0]).toMatchObject({ name: 'Alex Rivera', raw: 'Alex Rivera 140', org: 'DSTA', groups: ['Family', 'Work'], tags: ['140', 'DSTA'] });
    expect(r.people[1].groups).toEqual([]);
    expect(r.groups).toEqual([
      { name: 'Family', members: ['Alex Rivera'] },
      { name: 'Work', members: ['Alex Rivera'] },
    ]);
    expect(r.warnings).toEqual(['1 row had no name and was skipped']);
    expect(r.dropped).toEqual(['E-mail 1 - Value', 'Phone 1 - Value']);
    const json = JSON.stringify(r);
    expect(json).not.toContain('example.com');
    expect(json).not.toContain('9123');
  });

  it('splits group cells on commas and semicolons and parses dates', () => {
    const rows = parseCSV('Name,Tags,Last Contacted\nZoe Park,"a, b;c",Oct 3 2026\nBo Li,,garbage');
    const r = csvToResult(rows, detectPreset(rows[0]).mapping, 'Notion');
    expect(r.people[0].groups).toEqual(['a', 'b', 'c']);
    expect(r.people[0].lastContact).toBe('2026-10-03');
    expect(r.people[1].lastContact).toBeUndefined();
  });

  it('prefers the name column and falls back to first + last', () => {
    const rows = [['Name', 'First', 'Last'], ['', 'Ann', 'Wu'], ['Bea Cho', 'x', 'y']];
    const r = csvToResult(rows, { name: 'Name', firstName: 'First', lastName: 'Last', groups: [] }, 's');
    expect(r.people.map((p) => p.name)).toEqual(['Ann Wu', 'Bea Cho']);
  });
});
