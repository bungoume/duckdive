import { resolveRange, timeContext, type TimeRange } from './datemath';
import type { SavedVis, UrlState, VisState } from './state';

/** Keep file selection and chart queries in agreement about which charts compare periods. */
export function supportsComparison(vis: VisState): boolean {
  return !!vis.compare && vis.x.kind === 'date_histogram' && ['area', 'line', 'bar'].includes(vis.chart);
}

export function needsComparison(url: UrlState, saved: SavedVis[]): boolean {
  return url.page === 'visualize'
    ? supportsComparison(url.vis)
    : url.page === 'dashboard' && saved.some((s) => s.pinned && supportsComparison(s.vis));
}

/** The source must contain the preceding period before a comparison query can see its rows. */
export function fileWindow(
  range: TimeRange,
  compare: boolean,
  context = timeContext(),
): { from: Date; to: Date } | null {
  const r = resolveRange(range, context);
  if (!r) return null;
  const span = r.to.getTime() - r.from.getTime();
  return compare && span > 0 ? { from: new Date(r.from.getTime() - span), to: r.to } : r;
}
