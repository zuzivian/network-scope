import { describe, it, expect } from 'vitest';
import { detectJson, fixMojibake, parseFacebookFriends, parseInstagram } from './social';

describe('Facebook', () => {
  it('fixes mojibake', () => {
    expect(fixMojibake('JosÃ©')).toBe('José');
    expect(fixMojibake('José')).toBe('José'); // already correct: left alone
    expect(fixMojibake('plain')).toBe('plain');
    expect(fixMojibake('Ã(')).toBe('Ã('); // invalid UTF-8: left alone
    expect(fixMojibake('ZoÃ« ☃')).toBe('ZoÃ« ☃'); // not all < 256
  });

  it('parses friends_v2 with timestamps', () => {
    const r = parseFacebookFriends({
      friends_v2: [
        { name: 'JosÃ© GarcÃ­a', timestamp: 1600000000 },
        { name: 'MAJ Alex Rivera 140', timestamp: 1700000000 },
        { timestamp: 1 },
      ],
    });
    expect(r.kind).toBe('facebook');
    expect(r.source).toBe('Facebook friends');
    expect(r.people.map((p) => p.name)).toEqual(['José García', 'Alex Rivera']);
    expect(r.people[0].connectedOn).toBe('2020-09-13');
    expect(r.people[1].rank).toBe('MAJ');
    expect(r.warnings).toEqual(['1 entry had no name and was skipped']);
  });

  it('accepts the older "friends" key', () => {
    expect(parseFacebookFriends({ friends: [{ name: 'Ann Wu', timestamp: 1600000000 }] }).people).toHaveLength(1);
  });
});

describe('Instagram', () => {
  const item = (value: string, ts = 1600000000) => ({
    string_list_data: [{ href: `https://www.instagram.com/${value}`, value, timestamp: ts }],
  });

  it('parses followers_1.json (array)', () => {
    const r = parseInstagram([item('ada_q'), item('ben.o')], 'followers_1.json');
    expect(r.kind).toBe('instagram');
    expect(r.source).toBe('Instagram followers');
    expect(r.people[0]).toMatchObject({
      name: 'ada_q',
      raw: 'ada_q',
      url: 'https://www.instagram.com/ada_q',
      connectedOn: '2020-09-13',
      groups: ['Instagram followers'],
    });
    expect(r.groups).toEqual([{ name: 'Instagram followers', members: ['ada_q', 'ben.o'] }]);
  });

  it('parses following.json (object) including username in title', () => {
    const r = parseInstagram(
      {
        relationships_following: [
          item('cy'),
          { title: 'dee', string_list_data: [{ href: 'https://www.instagram.com/_u/dee', timestamp: 1600000000 }] },
        ],
      },
      'following.json',
    );
    expect(r.source).toBe('Instagram following');
    expect(r.people.map((p) => p.name)).toEqual(['cy', 'dee']);
  });

  it('falls back to shape when the filename is uninformative', () => {
    expect(parseInstagram({ relationships_following: [item('x')] }, 'a.json').source).toBe('Instagram following');
    expect(parseInstagram([item('x')], 'a.json').source).toBe('Instagram followers');
  });
});

describe('detectJson', () => {
  it('distinguishes facebook, instagram and unknown', () => {
    expect(detectJson({ friends_v2: [] }, 'x.json')).toBe('facebook');
    expect(detectJson({ friends: [] }, 'x.json')).toBe('facebook');
    expect(detectJson([{ string_list_data: [] }], 'followers_1.json')).toBe('instagram');
    expect(detectJson({ relationships_following: [] }, 'following.json')).toBe('instagram');
    expect(detectJson({ hello: 1 }, 'x.json')).toBeNull();
    expect(detectJson('str', 'x.json')).toBeNull();
    expect(detectJson(null, 'x.json')).toBeNull();
  });
});
