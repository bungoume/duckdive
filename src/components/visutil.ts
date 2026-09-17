// Bits shared by the Visualize page and the dashboard tiles: what a click on a chart means for
// the search, and the axis labels of a chart definition.
import { t } from '../i18n';
import { NULL_GROUP, OTHER } from '../queries';
import { intervalLabel, newId, type Interval } from '../sql';
import type { SearchState, VisState } from '../state';
import type { ChartPick } from './Chart';

/**
 * The search after a click on a chart: a breakdown value or a terms bucket becomes a filter, a
 * time bucket becomes the time range; null when the click means nothing.
 */
export function searchAfterPick(vis: VisState, groups: string[], pick: ChartPick, search: SearchState): SearchState | null {
  const withFilter = (field: string, value: string | null): SearchState => ({
    ...search,
    filters: [...search.filters, value === null ? { id: newId(), field, op: 'does_not_exist' } : { id: newId(), field, op: 'is', value }],
  });
  if (vis.breakdown.field && groups.length) {
    if (pick.series === OTHER) {
      const top = groups.filter((g) => g !== OTHER);
      return top.length ? { ...search, filters: [...search.filters, { id: newId(), field: vis.breakdown.field, op: 'is_not_one_of', values: top }] } : null;
    }
    return withFilter(vis.breakdown.field, pick.series === NULL_GROUP ? null : pick.series);
  }
  if (vis.x.kind === 'terms' && vis.x.field) return withFilter(vis.x.field, pick.x === NULL_GROUP ? null : String(pick.x));
  if (pick.isTime && pick.x instanceof Date && pick.intervalMs) {
    return { ...search, range: { from: pick.x.toISOString(), to: new Date(pick.x.getTime() + pick.intervalMs).toISOString() } };
  }
  return null;
}

/** "@timestamp per minute", "Top 5 values of host" or "http.bytes in steps of 1000". */
export function xAxisLabel(vis: VisState, interval: Interval | null, timeFieldName: string | null, step: number | null = null): string {
  switch (vis.x.kind) {
    case 'date_histogram':
      return t('vis.xLabel.date', { field: vis.x.field ?? timeFieldName ?? t('vis.time'), interval: interval ? intervalLabel(interval).toLowerCase() : '' });
    case 'terms':
      return t('vis.xLabel.terms', { n: vis.x.size, field: vis.x.field ?? '?' });
    case 'histogram':
      return t('vis.xLabel.hist', { field: vis.x.field ?? '?', size: step ?? (Number(vis.x.interval) > 0 ? vis.x.interval : t('common.auto')) });
    default:
      return '';
  }
}

export function breakdownLabel(vis: VisState): string | null {
  return vis.breakdown.field ? t('vis.xLabel.terms', { n: vis.breakdown.size, field: vis.breakdown.field }) : null;
}
