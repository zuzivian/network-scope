import { describe, it, expect } from 'vitest';
import { extractTags, COMMON_SURNAMES, RANKS, makePerson } from './tags';

describe('extractTags', () => {
  it('pulls rank and numeric tags', () => {
    expect(extractTags('MAJ Alex Rivera 140')).toEqual({ name: 'Alex Rivera', rank: 'MAJ', tags: ['140'] });
  });

  it('handles class-year tokens and curly apostrophes', () => {
    expect(extractTags('Lena Brightwater GSB\'28 NU’21').tags).toEqual(["GSB'28", "NU'21"]);
    expect(extractTags('Lena Brightwater GSB\'28 NU’21').name).toBe('Lena Brightwater');
    expect(extractTags("Sam Lee MSx'27 Partner'28").tags).toEqual(["MSx'27", "Partner'28"]);
  });

  it('expands parenthesised groups', () => {
    const r = extractTags('Owen Hart (YFC GRP/ABC)');
    expect(r.name).toBe('Owen Hart');
    expect(r.tags).toEqual(['YFC', 'GRP', 'ABC']);
  });

  it('splits slash tokens', () => {
    expect(extractTags('Theo Marsh 140/142')).toEqual({ name: 'Theo Marsh', tags: ['140', '142'] });
  });

  it('collapses duplicate words and underscores', () => {
    expect(extractTags('Joseph _Joseph Ward').name).toBe('Joseph Ward');
    expect(extractTags('Joseph Joseph Ward').name).toBe('Joseph Ward');
  });

  it('treats a trailing all-caps word as a surname', () => {
    expect(extractTags('Shaun TAN')).toEqual({ name: 'Shaun Tan', tags: [] });
  });

  it('keeps allowlisted acronyms as tags even when last', () => {
    expect(extractTags('Ravi YFC')).toEqual({ name: 'Ravi', tags: ['YFC'] });
  });

  it('recognises code words in any case, as written', () => {
    expect(extractTags('Milo Grant bravo 140')).toEqual({ name: 'Milo Grant', tags: ['bravo', '140'] });
    expect(extractTags('Mia Ong Alpha').tags).toEqual(['Alpha']);
  });

  it('keeps hyphenated compounds whole and picks up alphanumerics', () => {
    expect(extractTags('Lena Koh ABC-XYZ 12QR 101SQN 4B2').tags).toEqual(['ABC-XYZ', '12QR', '101SQN', '4B2']);
  });

  it('does not treat a lone Dr as a rank', () => {
    expect(extractTags('Dr Smith')).toEqual({ name: 'Dr Smith', tags: [] });
    expect(extractTags('Dr Jane Smith')).toEqual({ name: 'Jane Smith', rank: 'DR', tags: [] });
  });

  it('keeps original words if everything would be stripped', () => {
    expect(extractTags('140').name).toBe('140');
    expect(extractTags('MAJ').name).not.toBe('');
  });

  it('treats an all-caps full name as a name', () => {
    expect(extractTags('ALEX MORENO').name).toBe('Alex Moreno');
    expect(extractTags('ALEX MORENO').tags).toEqual([]);
  });

  it('removes duplicate tags', () => {
    expect(extractTags('Tim Goh 140 140 (140)').tags).toEqual(['140']);
  });

  it('exports its allowlist and rank constants', () => {
    expect(COMMON_SURNAMES.has('TAN')).toBe(true);
    expect(extractTags('Mei LI').name).toBe('Mei Li');
    expect(extractTags('Priya ACME').tags).toEqual(['ACME']);
    expect(makePerson('Cara Ng', { role: 'PM', org: 'Planet' }).tags).toEqual([]);
    expect(makePerson('Dev Raman', { role: 'CTO, R&D' }).tags).toEqual([]);
    expect(RANKS.has('ME1T')).toBe(true);
  });
});

describe('makePerson', () => {
  it('merges tags from org and role but keeps the strings', () => {
    const p = makePerson('MAJ Alex Rivera 140', { org: 'DSTA', role: 'Engineer (Contract)' });
    expect(p.org).toBe('DSTA');
    expect(p.role).toBe('Engineer (Contract)');
    expect(p.raw).toBe('MAJ Alex Rivera 140');
    expect(p.tags).toEqual(['140', 'DSTA']);
  });
});
