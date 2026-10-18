// Public build stand-in for local-data.ts: no local files, ever.
import type { Sources } from './model';
import type { Contact, SortStore } from './sort';

export const hasLocalData = false;
export const localContacts: Contact[] = [];
export function localSources(): Sources | null {
  return null;
}
export function localSortStore(): SortStore {
  throw new Error('No local data in the public build');
}
