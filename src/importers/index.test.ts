import { describe, it, expect } from 'vitest';
import { importFile, csvToResult, type ImportResult } from './index';

describe('importFile', () => {
  it('dispatches .vcf', () => {
    const r = importFile({ name: 'c.vcf', text: 'BEGIN:VCARD\nFN:Ann Wu\nEND:VCARD' }) as ImportResult;
    expect(r.kind).toBe('vcard');
  });

  it('dispatches LinkedIn csv with preamble', () => {
    const text = 'Notes:\n"x"\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nAda,Q,u,,Acme,Eng,01 Oct 2026\n';
    const r = importFile({ name: 'Connections.csv', text }) as ImportResult;
    expect(r.kind).toBe('linkedin');
    expect(r.people[0].connectedOn).toBe('2026-10-01');
  });

  it('asks for a mapping on other csv files', () => {
    const r = importFile({ name: 'people.csv', text: 'Full Name,Employer\nAnn Wu,Acme\n' });
    if (!('needsMapping' in r)) throw new Error('expected needsMapping');
    expect(r.preset).toBe('generic');
    expect(r.headers).toEqual(['Full Name', 'Employer']);
    const result = csvToResult(r.rows, r.mapping, 'people.csv');
    expect(result.people[0]).toMatchObject({ name: 'Ann Wu', org: 'Acme' });
  });

  it('dispatches whatsapp and json files', () => {
    expect((importFile({ name: 'WhatsApp Chat with A B.txt', text: '01/02/2026, 10:00 - A B: hi' }) as ImportResult).kind).toBe('whatsapp');
    expect((importFile({ name: 'your_friends.json', text: '{"friends_v2":[{"name":"A B","timestamp":1600000000}]}' }) as ImportResult).kind).toBe('facebook');
    expect((importFile({ name: 'followers_1.json', text: '[{"string_list_data":[{"value":"x","timestamp":1}]}]' }) as ImportResult).kind).toBe('instagram');
  });

  it('throws friendly errors', () => {
    expect(() => importFile({ name: 'x.json', text: '{"a":1}' })).toThrow(/recognise/);
    expect(() => importFile({ name: 'x.json', text: 'nope' })).toThrow(/valid JSON/);
    expect(() => importFile({ name: 'x.pdf', text: '' })).toThrow(/Unsupported/);
    expect(() => importFile({ name: 'x.csv', text: '' })).toThrow(/empty/);
  });
});
