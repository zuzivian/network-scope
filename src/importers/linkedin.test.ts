import { describe, it, expect } from 'vitest';
import { isLinkedInCsv, parseLinkedInConnections } from './linkedin';

const PREAMBLE = [
  'Notes:',
  '"When exporting your connection data, you may notice that some of the email addresses are missing, due to privacy settings."',
  '',
].join('\n');
const HEADER = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On';

describe('parseLinkedInConnections', () => {
  const text = [
    PREAMBLE,
    HEADER,
    'Ada,Quill,https://www.linkedin.com/in/ada-quill,ada@example.com,"Acme, Inc.",Engineer,01 Oct 2026',
    'Ben,Okoro,https://www.linkedin.com/in/ben-okoro,,DSTA,Director,5 Sep 2025',
    ',,,,,,',
  ].join('\n');

  it('skips the preamble and maps fields', () => {
    const r = parseLinkedInConnections(text);
    expect(r.kind).toBe('linkedin');
    expect(r.source).toBe('LinkedIn connections');
    expect(r.people).toHaveLength(2);
    expect(r.people[0]).toMatchObject({
      name: 'Ada Quill',
      org: 'Acme, Inc.',
      role: 'Engineer',
      url: 'https://www.linkedin.com/in/ada-quill',
      connectedOn: '2026-10-01',
      groups: [],
    });
    expect(r.people[1].connectedOn).toBe('2025-09-05');
    expect(r.groups).toEqual([]);
  });

  it('always lists Email Address as dropped and never keeps the email', () => {
    const r = parseLinkedInConnections(text);
    expect(r.dropped).toContain('Email Address');
    expect(JSON.stringify(r)).not.toContain('example.com');
  });

  it('works without a preamble and with CRLF', () => {
    const r = parseLinkedInConnections(`${HEADER}\r\nCy,Dunn,https://x,,Org,Role,2 Jan 2024\r\n`);
    expect(r.people[0].connectedOn).toBe('2024-01-02');
  });

  it('reports a missing header instead of throwing', () => {
    const r = parseLinkedInConnections('nothing here');
    expect(r.people).toEqual([]);
    expect(r.warnings.length).toBe(1);
  });

  it('detects LinkedIn files', () => {
    expect(isLinkedInCsv(text)).toBe(true);
    expect(isLinkedInCsv('Name,Company\nA,B')).toBe(false);
  });
});
