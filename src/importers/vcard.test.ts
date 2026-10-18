import { describe, it, expect } from 'vitest';
import { parseVCards } from './vcard';

describe('parseVCards', () => {
  const text = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:MAJ Alex Rivera 140',
    'N:Fan;Kelvin;;MAJ;',
    'item1.ORG;type=pref:DSTA;Digital Dept',
    'TITLE:Senior Engineer\\, Platform',
    'CATEGORIES:Family,Work\\, Singapore',
    'TEL;TYPE=CELL:+65 9123 4567',
    'EMAIL;TYPE=INTERNET:alex@example.com',
    'ADR;TYPE=HOME:;;1 Fake Street;Town;;12345;SG',
    'BDAY:1990-01-01',
    'NOTE:Met at the very secret thing',
    'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQ',
    ' AAAAAAAAAAAAAAAAAAAA',
    'X-SOCIALPROFILE;type=twitter:http://twitter.com/kelvin',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Mu=C3=B1oz;Jos=C3=A9;;;',
    'ORG;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Caf=C3=A9 =',
    'Corp',
    'TEL;CELL:+1 650 555 0100',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:Doe;Jane;Q;;',
    'NOTE:long note that is fol',
    ' ded across lines',
    'END:VCARD',
    'BEGIN:VCARD',
    'ORG:Nameless Co',
    'END:VCARD',
  ].join('\r\n');

  const r = parseVCards(text);

  it('parses multiple cards with FN preferred over N', () => {
    expect(r.kind).toBe('vcard');
    expect(r.source).toBe('Contacts (vCard)');
    expect(r.people.map((p) => p.name)).toEqual(['Alex Rivera', 'José Muñoz', 'Jane Q Doe']);
  });

  it('handles params, escapes, org first component and title', () => {
    expect(r.people[0]).toMatchObject({
      raw: 'MAJ Alex Rivera 140',
      rank: 'MAJ',
      org: 'DSTA',
      role: 'Senior Engineer, Platform',
      groups: ['Family', 'Work, Singapore'],
    });
    expect(r.people[0].tags).toContain('140');
    expect(r.people[0].tags).toContain('DSTA');
  });

  it('decodes quoted-printable with soft line breaks', () => {
    expect(r.people[1].org).toBe('Café Corp');
  });

  it('builds groups from categories', () => {
    expect(r.groups).toEqual([
      { name: 'Family', members: ['Alex Rivera'] },
      { name: 'Work, Singapore', members: ['Alex Rivera'] },
    ]);
  });

  it('drops contact fields once each and warns about nameless cards', () => {
    expect(r.dropped).toEqual(['TEL', 'EMAIL', 'ADR', 'BDAY', 'NOTE', 'PHOTO', 'X-SOCIALPROFILE']);
    expect(r.warnings).toEqual(['1 card had no name and was skipped']);
    const json = JSON.stringify(r);
    for (const s of ['example.com', '9123', '555', 'Fake Street', '1990', 'secret', '/9j/', 'twitter']) {
      expect(json).not.toContain(s);
    }
  });
});
