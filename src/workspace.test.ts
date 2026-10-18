import { describe, it, expect } from 'vitest';
import type { ImportResult } from './importers/types';
import { emptyWorkspace, findDuplicates, markNotDuplicate, mergeImport, mergePeople } from './workspace';
import { introPath, buildNetwork } from './model';
import { toSources } from './workspace';

const person = (name: string, org?: string, groups: string[] = []) => ({ name, raw: name, org, tags: [], groups });
const result = (kind: ImportResult['kind'], people: ReturnType<typeof person>[], groups: ImportResult['groups'] = []): ImportResult =>
  ({ kind, source: kind, people, groups, warnings: [], dropped: [] });
const opt = { world: { newName: 'Work' }, groupContexts: true, companyContexts: true };

describe('duplicates', () => {
  it('keeps same-name people at different companies apart, and flags them', () => {
    const ws = emptyWorkspace('Me');
    mergeImport(ws, result('linkedin', [person('Chris Lee', 'Acme'), person('Chris Lee', 'Globex')]), opt);
    expect(ws.people.map((p) => p.id).sort()).toEqual(['chris-lee', 'chris-lee-2']);
    expect(findDuplicates(ws)[0].why).toMatch(/different companies/);
    // Re-importing finds the right one instead of making a third.
    mergeImport(ws, result('linkedin', [person('Chris Lee', 'Globex')]), opt);
    expect(ws.people).toHaveLength(2);
  });

  it('flags nicknames, and merges or dismisses on request', () => {
    const ws = emptyWorkspace('Me');
    mergeImport(ws, result('vcard', [person('Bob Smith'), person('Robert Smith', 'Acme'), person('Kate Ng'), person('Katherine Ng')]), opt);
    expect(findDuplicates(ws).map((d) => d.why)).toEqual(['Nickname or short form of the same name', 'Nickname or short form of the same name']);
    mergePeople(ws, 'robert-smith', 'bob-smith');
    markNotDuplicate(ws, 'kate-ng', 'katherine-ng');
    expect(findDuplicates(ws)).toEqual([]);
    expect(ws.people.find((p) => p.id === 'robert-smith')!.org).toBe('Acme');
  });
});

describe('intro paths', () => {
  it('routes through someone who shares a small group with the target', () => {
    const ws = emptyWorkspace('Me');
    mergeImport(ws, result('vcard', [person('Ana Ruiz', undefined, ['Study group']), person('Ben Cho', undefined, ['Study group'])], [{ name: 'Study group', members: ['Ana Ruiz', 'Ben Cho'] }]), opt);
    ws.people.find((p) => p.id === 'ben-cho')!.met = false;
    const net = buildNetwork(toSources(ws));
    const path = introPath(net, 'ben-cho')!;
    expect(path.map((s) => s.id)).toEqual(['ana-ruiz', 'ben-cho']);
    expect(path[1].why).toBe('Ana Ruiz → Ben Cho: Both in Study group');
  });
});
