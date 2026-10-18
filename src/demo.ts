// Fictional sample network for the "Try sample data" button. Safe to ship publicly.
import graph from '../data/fixtures/graph.json';
import networking from '../data/fixtures/networking-tracker.json';
import classmates from '../data/fixtures/classmate-network.json';
import type { GraphFile, Sources } from './model';

export function demoSources(): Sources {
  return {
    graph: { data: graph as GraphFile, sample: true },
    imports: [],
    networking: { rows: networking as Record<string, unknown>[], sample: true },
    classmates: { rows: classmates as Record<string, unknown>[], sample: true },
    encounters: [],
    rules: {
      aliases: {},
      whereMet: [
        { match: 'section b', context: 'section-b' },
        { match: 'study group', context: 'study-group-4' },
        { match: 'veterans', context: 'veterans-club' },
        { match: 'aerospace', context: 'aerospace-defense-club' },
        { match: 'orientation', context: 'orientation' },
        { match: 'classmate', context: 'mba' },
      ],
    },
  };
}
