import type { AppPage, UrlState } from './state';
import { shareableSource, sourceFromLink, type SourceConfig } from './sources';
import { isObj, restoreSearch, sanitizeDiscover, sanitizeVis } from './stateCodec';

function b64encode(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function b64decode(s: string): string {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(t + '='.repeat((4 - (t.length % 4)) % 4))));
}

export function readUrlState(): UrlState {
  const h = location.hash.replace(/^#\/?/, '');
  const [pageRaw, qs] = h.split('?');
  const page: AppPage = pageRaw === 'visualize' || pageRaw === 'dashboard' || pageRaw === 'sql' || pageRaw === 'source' || pageRaw === 'settings' ? pageRaw : 'discover';
  let st: Record<string, unknown> = {};
  if (qs) {
    const p = new URLSearchParams(qs);
    const s = p.get('s');
    if (s) {
      try {
        const parsed: unknown = JSON.parse(b64decode(s));
        if (isObj(parsed) && (parsed.version === undefined || parsed.version === 1)) st = parsed;
      } catch {
        st = {};
      }
    }
  }
  return { page, search: restoreSearch(st.search), discover: sanitizeDiscover(st.discover), vis: sanitizeVis(st.vis) };
}

/** The data source a shared link carries (its `src` parameter), or null. Read once at start-up: writeUrlState drops it. */
export function readLinkSource(): SourceConfig | null {
  const qs = location.hash.split('?')[1];
  const v = qs ? new URLSearchParams(qs).get('src') : null;
  if (!v) return null;
  try {
    return sourceFromLink(JSON.parse(b64decode(v)));
  } catch {
    return null;
  }
}

/** A link to this view for someone else: the state plus, when it can travel, the data source without its secrets. */
export function shareLink(u: UrlState, source: SourceConfig | null): string {
  const { page, ...rest } = u;
  const share = source && shareableSource(source);
  const src = share ? `&src=${b64encode(JSON.stringify(share))}` : '';
  return `${location.href.split('#')[0]}#/${page}?s=${b64encode(JSON.stringify({ version: 1, ...rest }))}${src}`;
}

let lastSearchKey: string | null = null;

/**
 * Mirror the state into the URL hash. Changes of the search (query, time range, filters)
 * create a history entry so the browser's Back button restores the previous view; other
 * changes (page, columns, chart settings) replace the current entry.
 */
export function writeUrlState(u: UrlState) {
  const { page, ...rest } = u;
  const enc = b64encode(JSON.stringify({ version: 1, ...rest }));
  const next = `#/${page}?s=${enc}`;
  const searchKey = JSON.stringify(u.search);
  const searchChanged = lastSearchKey !== null && lastSearchKey !== searchKey;
  lastSearchKey = searchKey;
  if (location.hash === next) return;
  if (searchChanged) history.pushState(null, '', next);
  else history.replaceState(null, '', next);
}

/**
 * Call when the URL was changed by navigation (Back / Forward, or a typed hash). Returns the
 * state carried by the URL; `full` is false when the hash names only a page (e.g. "#/source"),
 * in which case the caller keeps its current search / chart state. Never pushes.
 */
export function syncUrlStateFromLocation(): { state: UrlState; full: boolean } {
  const u = readUrlState();
  const full = /[?&]s=/.test(location.hash);
  if (full) lastSearchKey = JSON.stringify(u.search);
  return { state: u, full };
}
