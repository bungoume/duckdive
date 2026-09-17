import type { TimeRange } from './datemath';
import type { Filter, FilterOp } from './sql';
import { isTrustedSql } from './trust';

export type AppPage = 'discover' | 'visualize' | 'source' | 'settings';

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
  chart: 'bar',
  x: { kind: 'date_histogram', field: null, interval: 'auto', size: 10, orderBy: 'metric', orderDir: 'desc' },
  metrics: [{ id: 'm0', agg: 'count', field: null }],
  breakdown: { field: null, size: 5, other: true },
  title: '',
};

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

// ---------- validation of state that arrives from a URL or from localStorage ----------
//
// A hand-edited or truncated link must never take the page down: every field is checked and
// anything malformed falls back to its default.

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strOrNull = (v: unknown): string | null => (isStr(v) ? v : null);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);

const FILTER_OPS: readonly FilterOp[] = ['is', 'is_not', 'is_one_of', 'is_not_one_of', 'exists', 'does_not_exist', 'between', 'query'];
const CHARTS: readonly ChartType[] = ['area', 'line', 'bar', 'table', 'metric'];
const AGGS: readonly MetricAgg[] = ['count', 'sum', 'avg', 'min', 'max', 'median', 'unique', 'p95', 'p99'];
const X_KINDS: readonly XAxisDef['kind'][] = ['date_histogram', 'terms', 'histogram', 'none'];

/**
 * Filters carried by a URL. Anything malformed is dropped. Custom SQL filters run verbatim inside
 * DuckDB, so SQL that was not written in this browser (a link someone sent) is restored disabled
 * and marked untrusted; FilterBar lets the user review and enable it. `quarantine` is off for
 * filters read back from this browser's own localStorage (saved visualizations).
 */
function sanitizeFilters(raw: unknown, quarantine = true): Filter[] {
  if (!Array.isArray(raw)) return [];
  const out: Filter[] = [];
  for (const item of raw) {
    if (!isObj(item) || !isStr(item.id) || !isStr(item.field) || !FILTER_OPS.includes(item.op as FilterOp)) continue;
    const f: Filter = { id: item.id, field: item.field, op: item.op as FilterOp };
    if (isStr(item.value)) f.value = item.value;
    if (Array.isArray(item.values)) f.values = item.values.filter(isStr);
    if (isStr(item.from)) f.from = item.from;
    if (isStr(item.to)) f.to = item.to;
    if (item.negate === true) f.negate = true;
    if (item.disabled === true) f.disabled = true;
    if (isStr(item.label)) f.label = item.label;
    if (f.op === 'query') {
      f.sql = isStr(item.sql) ? item.sql : '';
      if (quarantine && !isTrustedSql(f.sql)) {
        f.disabled = true;
        f.untrusted = true;
      }
    }
    out.push(f);
  }
  return out;
}

export function sanitizeSearch(raw: unknown, quarantine = true): SearchState {
  const r = isObj(raw) ? raw : {};
  const range = isObj(r.range) && isStr(r.range.from) && isStr(r.range.to) ? { from: r.range.from, to: r.range.to } : DEFAULT_SEARCH.range;
  return { query: isStr(r.query) ? r.query : '', range, filters: sanitizeFilters(r.filters, quarantine) };
}

function sanitizeDiscover(raw: unknown): DiscoverState {
  const r = isObj(raw) ? raw : {};
  const sort = Array.isArray(r.sort)
    ? r.sort.filter((s): s is { field: string; dir: SortDir } => isObj(s) && isStr(s.field) && (s.dir === 'asc' || s.dir === 'desc')).map((s) => ({ field: s.field, dir: s.dir }))
    : [];
  return { columns: strList(r.columns), sort, interval: isStr(r.interval) ? r.interval : DEFAULT_DISCOVER.interval };
}

export function sanitizeVis(raw: unknown): VisState {
  const r = isObj(raw) ? raw : {};
  const dx = DEFAULT_VIS.x;
  const x = isObj(r.x) ? r.x : {};
  const metrics: MetricDef[] = Array.isArray(r.metrics)
    ? r.metrics.filter(isObj).map((m, i) => {
        const def: MetricDef = { id: isStr(m.id) ? m.id : `m${i}`, agg: oneOf(m.agg, AGGS, 'count'), field: strOrNull(m.field) };
        if (isStr(m.label)) def.label = m.label;
        return def;
      })
    : [];
  const b = isObj(r.breakdown) ? r.breakdown : {};
  return {
    chart: oneOf(r.chart, CHARTS, DEFAULT_VIS.chart),
    x: {
      kind: oneOf(x.kind, X_KINDS, dx.kind),
      field: strOrNull(x.field),
      interval: isStr(x.interval) ? x.interval : dx.interval,
      size: typeof x.size === 'number' && x.size > 0 ? Math.floor(x.size) : dx.size,
      orderBy: oneOf(x.orderBy, ['metric', 'alpha'] as const, dx.orderBy),
      orderDir: oneOf(x.orderDir, ['asc', 'desc'] as const, dx.orderDir),
    },
    metrics: metrics.length ? metrics : DEFAULT_VIS.metrics,
    breakdown: {
      field: strOrNull(b.field),
      size: typeof b.size === 'number' && b.size > 0 ? Math.floor(b.size) : DEFAULT_VIS.breakdown.size,
      other: typeof b.other === 'boolean' ? b.other : DEFAULT_VIS.breakdown.other,
    },
    title: isStr(r.title) ? r.title : '',
  };
}

export function readUrlState(): UrlState {
  const h = location.hash.replace(/^#\/?/, '');
  const [pageRaw, qs] = h.split('?');
  const page: AppPage = pageRaw === 'visualize' || pageRaw === 'source' || pageRaw === 'settings' ? pageRaw : 'discover';
  let st: Record<string, unknown> = {};
  if (qs) {
    const p = new URLSearchParams(qs);
    const s = p.get('s');
    if (s) {
      try {
        const parsed: unknown = JSON.parse(b64decode(s));
        if (isObj(parsed)) st = parsed;
      } catch {
        st = {};
      }
    }
  }
  return { page, search: sanitizeSearch(st.search), discover: sanitizeDiscover(st.discover), vis: sanitizeVis(st.vis) };
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

const LS_VIS = 'ddv.savedVis';

export interface SavedVis {
  id: string;
  title: string;
  savedAt: string;
  vis: VisState;
  search: SearchState;
}

export function loadSavedVis(): SavedVis[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(LS_VIS) ?? '[]');
    if (!Array.isArray(list)) return [];
    // written by this browser: no quarantine of custom SQL, but the shapes are still checked
    return list.filter(isObj).map((e, i) => ({
      id: isStr(e.id) ? e.id : `saved${i}`,
      title: isStr(e.title) ? e.title : '',
      savedAt: isStr(e.savedAt) ? e.savedAt : '',
      vis: sanitizeVis(e.vis),
      search: sanitizeSearch(e.search, false),
    }));
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
