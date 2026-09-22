import type { SavedVis, SavedSearch } from './state';
import { isStr, isObj, restoreSearch, sanitizeDiscover, sanitizeVis } from './stateCodec';
import { createStore } from './store';

/** Versionless arrays are the original storage format. Read them without rewriting them. */
function readList(key: string): unknown {
  const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
  if (Array.isArray(raw)) return raw;
  return isObj(raw) && raw.version === 1 ? raw.items : [];
}

const LS_VIS = 'ddv.savedVis';
/** Consumers that select source files must react when a comparison tile is pinned or edited. */
export const savedVisRevision = createStore(0);

export function loadSavedVis(): SavedVis[] {
  try {
    const list: unknown = readList(LS_VIS);
    if (!Array.isArray(list)) return [];
    return list.filter(isObj).map((e, i) => ({
      id: isStr(e.id) ? e.id : `saved${i}`,
      title: isStr(e.title) ? e.title : '',
      savedAt: isStr(e.savedAt) ? e.savedAt : '',
      vis: sanitizeVis(e.vis),
      search: restoreSearch(e.search),
      pinned: e.pinned === true,
    }));
  } catch {
    return [];
  }
}

export function storeSavedVis(list: SavedVis[]) {
  try {
    localStorage.setItem(LS_VIS, JSON.stringify({ version: 1, items: list }));
  } catch {
    /* ignore */
  }
  savedVisRevision.set(savedVisRevision.get() + 1);
}

const LS_SEARCHES = 'ddv.savedSearches';

/** A Discover view kept under a name: query, filters and time range, plus columns, sort and interval. */

export function loadSavedSearches(): SavedSearch[] {
  try {
    const list: unknown = readList(LS_SEARCHES);
    if (!Array.isArray(list)) return [];
    return list.filter(isObj).map((e, i) => ({
      id: isStr(e.id) ? e.id : `search${i}`,
      title: isStr(e.title) ? e.title : '',
      savedAt: isStr(e.savedAt) ? e.savedAt : '',
      search: restoreSearch(e.search),
      discover: sanitizeDiscover(e.discover),
    }));
  } catch {
    return [];
  }
}

export function storeSavedSearches(list: SavedSearch[]) {
  try {
    localStorage.setItem(LS_SEARCHES, JSON.stringify({ version: 1, items: list }));
  } catch {
    /* ignore */
  }
}
