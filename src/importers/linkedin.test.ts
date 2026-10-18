import { describe, it, expect } from 'vitest';
import { isLinkedInCsv, parseLinkedInConnections, parseProfile, profileKind, sameOrg } from './linkedin';
import { placeByTimeline } from '../workspace';

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

describe('LinkedIn profile timeline', () => {
  const education = [
    'School Name,Start Date,End Date,Notes,Degree Name,Activities',
    'State University,2015,2019,,BS,"Rowing, debate"',
    'Business School,2026,2028,,MBA,',
  ].join('\n');
  const positions = [
    'Company Name,Title,Description,Location,Started On,Finished On',
    'Acme Corp,Analyst,"Secret project notes",NYC,Jul 2019,Jun 2026',
  ].join('\n');

  it('reads schools and jobs with academic-year dates, and nothing else', () => {
    expect(profileKind(education)).toBe('education');
    expect(profileKind(positions)).toBe('positions');
    expect(parseProfile(education)).toEqual([
      { org: 'State University', kind: 'school', start: '2015-08-01', end: '2019-06-30' },
      { org: 'Business School', kind: 'school', start: '2026-08-01', end: '2028-06-30' },
    ]);
    const jobs = parseProfile(positions);
    expect(jobs).toEqual([{ org: 'Acme Corp', kind: 'job', start: '2019-07-01', end: '2026-06-28' }]);
    expect(JSON.stringify(jobs)).not.toContain('Secret');
  });

  it('matches organisation names loosely', () => {
    expect(sameOrg('Amazon Web Services (AWS)', 'Amazon')).toBe(true);
    expect(sameOrg('Acme, Inc.', 'Acme Corp')).toBe(true);
    expect(sameOrg('Amazonia Ltd', 'Amazon')).toBe(false);
  });

  it('places connections by your own schools, jobs and when you connected', () => {
    const place = placeByTimeline([...parseProfile(education), ...parseProfile(positions)]);
    expect(place('Acme', 'Manager')).toBe('Acme Corp'); // a colleague
    expect(place('Globex', 'Engineer', '2017-03-02')).toBe('State University'); // connected at college
    expect(place('Globex', 'Engineer', '2021-03-02')).toBeNull(); // during a job: no guess
    expect(place('Globex', 'Engineer', '2026-09-02')).toBeNull(); // current school: could be anyone
    expect(place('Initech', 'MBA Candidate, Business School')).toBe('Business School');
  });
});
