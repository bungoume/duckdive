import { DEFAULT_OIDC, type OidcConfig } from './auth';
import type { FormatId } from './formats';
import type { TimeRange } from './datemath';
import type { Filter } from './sql';

export type AppPage = 'discover' | 'visualize' | 'source';

export interface S3Config {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  endpoint: string;
  urlStyle: 'vhost' | 'path';
}

export type AuthMode = 'none' | 'static' | 'oidc';

export interface SourceConfig {
  kind: 'demo' | 'url' | 'local';
  name: string;
  /** newline separated URLs / globs (s3://..., https://...) */
  urls: string;
  format: FormatId;
  s3: S3Config;
  /** how S3 credentials are obtained: none (public / presigned), static keys, OIDC → STS */
  authMode: AuthMode;
  oidc: OidcConfig;
  /** upper bound for files matched by patterns (0 = default) */
  maxFiles: number;
  /** values chosen for {name} tokens of the pattern (required before connecting) */
  tokenValues: Record<string, string[]>;
  timeField: string | null;
}

export const DEFAULT_SOURCE: SourceConfig = {
  kind: 'demo',
  name: 'demo-logs',
  urls: '',
  format: 'auto',
  s3: { region: 'ap-northeast-1', accessKeyId: '', secretAccessKey: '', sessionToken: '', endpoint: '', urlStyle: 'vhost' },
  authMode: 'static',
  oidc: DEFAULT_OIDC,
  maxFiles: 0,
  tokenValues: {},
  timeField: null,
};

export type SortDir = 'asc' | 'desc';

export interface DiscoverState {
  columns: string[];
  sort: { field: string; dir: SortDir }[];
  interval: string; // 'auto' or Interval.key
}

export type MetricAgg = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'median' | 'unique' | 'p95' | 'p99';
export type ChartType = 'area' | 'line' | 'bar' | 'table' | 'metric';

export interface MetricDef {
  id: string;
  agg: MetricAgg;
  field: string | null;
  label?: string;
}

export interface XAxisDef {
  kind: 'date_histogram' | 'terms' | 'histogram' | 'none';
  field: string | null;
  interval: string; // date: 'auto' | key ; histogram: bucket size as string
  size: number; // terms
  orderBy: 'metric' | 'alpha';
  orderDir: SortDir;
}

export interface BreakdownDef {
  field: string | null;
  size: number;
  other: boolean;
}

export interface VisState {
  chart: ChartType;
  x: XAxisDef;
  metrics: MetricDef[];
  breakdown: BreakdownDef;
  title: string;
}

export interface SearchState {
  query: string;
  range: TimeRange;
  filters: Filter[];
}

export interface UrlState {
  page: AppPage;
  search: SearchState;
  discover: DiscoverState;
  vis: VisState;
}

export const DEFAULT_SEARCH: SearchState = { query: '', range: { from: 'now-6h', to: 'now' }, filters: [] };
export const DEFAULT_DISCOVER: DiscoverState = { columns: [], sort: [], interval: 'auto' };
export const DEFAULT_VIS: VisState = {
  chart: 'area',
  x: { kind: 'date_histogram', field: null, interval: 'auto', size: 10, orderBy: 'metric', orderDir: 'desc' },
  metrics: [{ id: 'm0', agg: 'count', field: null }],
  breakdown: { field: null, size: 5, other: true },
  title: '',
};

function b64encode(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64decode(s: string): string {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(t + '='.repeat((4 - (t.length % 4)) % 4))));
}

export function readUrlState(): UrlState {
  const h = location.hash.replace(/^#\/?/, '');
  const [pageRaw, qs] = h.split('?');
  const page: AppPage = pageRaw === 'visualize' || pageRaw === 'source' ? pageRaw : 'discover';
  let st: Partial<UrlState> = {};
  if (qs) {
    const p = new URLSearchParams(qs);
    const s = p.get('s');
    if (s) {
      try {
        st = JSON.parse(b64decode(s));
      } catch {
        st = {};
      }
    }
  }
  return {
    page,
    search: { ...DEFAULT_SEARCH, ...(st.search ?? {}) },
    discover: { ...DEFAULT_DISCOVER, ...(st.discover ?? {}) },
    vis: { ...DEFAULT_VIS, ...(st.vis ?? {}) },
  };
}

let lastSearchKey: string | null = null;

/**
 * Mirror the state into the URL hash. Changes of the search (query, time range, filters)
 * create a history entry so the browser's Back button restores the previous view; other
 * changes (page, columns, chart settings) replace the current entry.
 */
export function writeUrlState(u: UrlState) {
  const { page, ...rest } = u;
  const enc = b64encode(JSON.stringify(rest));
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

const LS_SOURCE = 'ddv.source';
const LS_VIS = 'ddv.savedVis';

export function loadSource(): SourceConfig {
  try {
    const raw = localStorage.getItem(LS_SOURCE);
    if (raw) {
      const o = JSON.parse(raw);
      return { ...DEFAULT_SOURCE, ...o, s3: { ...DEFAULT_SOURCE.s3, ...(o.s3 ?? {}) }, oidc: { ...DEFAULT_OIDC, ...(o.oidc ?? {}) } };
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_SOURCE;
}

export function saveSource(s: SourceConfig) {
  try {
    localStorage.setItem(LS_SOURCE, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export interface SavedVis {
  id: string;
  title: string;
  savedAt: string;
  vis: VisState;
  search: SearchState;
}

export function loadSavedVis(): SavedVis[] {
  try {
    return JSON.parse(localStorage.getItem(LS_VIS) ?? '[]');
  } catch {
    return [];
  }
}

export function storeSavedVis(list: SavedVis[]) {
  try {
    localStorage.setItem(LS_VIS, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}
