export type View = 'graph' | 'scope' | 'sort' | 'data';

export interface State {
  selected: string | null;
  hidden: Set<string>; // world ids
  view: View;
  query: string;
}

export function createStore(initial: State) {
  let state = initial;
  const subs: ((s: State) => void)[] = [];
  return {
    get: () => state,
    set(patch: Partial<State>) {
      state = { ...state, ...patch };
      subs.forEach((f) => f(state));
    },
    subscribe(f: (s: State) => void) {
      subs.push(f);
      f(state);
    },
  };
}
