import type { TimeRange } from './datemath';
import type { Filter } from './sql';

export type AppPage = 'discover' | 'visualize' | 'dashboard' | 'sql' | 'source' | 'settings';

export type SortDir = 'asc' | 'desc';

export interface DiscoverState {
  columns: string[];
  sort: { field: string; dir: SortDir }[];
  interval: string; // 'auto' or Interval.key
  /** field whose top values split the histogram bars (null = plain count) */
  breakdown: string | null;
}

export type MetricAgg = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'median' | 'unique' | 'p95' | 'p99' | 'percentile' | 'rate';
export type ChartType = 'area' | 'line' | 'bar' | 'table' | 'metric';

export interface MetricDef {
  id: string;
  agg: MetricAgg;
  field: string | null;
  label?: string;
  /** the percentile (0–100) of a 'percentile' metric */
  param?: number;
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
  /** stacked charts: every x adds up to 100 % */
  percent?: boolean;
  /** logarithmic (symlog) vertical axis */
  log?: boolean;
  /** date histograms: the previous period of the same length as a dashed overlay */
  compare?: boolean;
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
export const DEFAULT_DISCOVER: DiscoverState = { columns: [], sort: [], interval: 'auto', breakdown: null };
export const DEFAULT_VIS: VisState = {
  chart: 'bar',
  x: { kind: 'date_histogram', field: null, interval: 'auto', size: 10, orderBy: 'metric', orderDir: 'desc' },
  metrics: [{ id: 'm0', agg: 'count', field: null }],
  breakdown: { field: null, size: 5, other: true },
  title: '',
};

export interface SavedVis {
  id: string;
  title: string;
  savedAt: string;
  vis: VisState;
  search: SearchState;
  /** shown on the Dashboard page */
  pinned?: boolean;
}

export interface SavedSearch {
  id: string;
  title: string;
  savedAt: string;
  search: SearchState;
  discover: DiscoverState;
}

export const MAX_TERM_VALUES = 500;
export const MAX_BREAKDOWN_VALUES = 50;
