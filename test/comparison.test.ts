import { describe, expect, it } from 'vitest';
import { fileWindow, needsComparison } from '../src/comparison';
import { concretePatterns } from '../src/s3list';
import { DEFAULT_DISCOVER, DEFAULT_SEARCH, DEFAULT_VIS, type SavedVis, type UrlState } from '../src/state';
import { savedVisRevision, storeSavedVis } from '../src/savedViews';

const range = { from: '2026-09-22T00:00:00Z', to: '2026-09-23T00:00:00Z' };
const url: UrlState = { page: 'visualize', search: { ...DEFAULT_SEARCH, range }, discover: DEFAULT_DISCOVER, vis: { ...DEFAULT_VIS, compare: true } };
const tile: SavedVis = { id: 'comparison', title: '', savedAt: '', search: url.search, vis: url.vis, pinned: true };

describe('comparison file coverage', () => {
  it('includes yesterday when today is compared, retaining delivery lag after today', () => {
    const pattern = 's3://logs/{yyyy}/{MM}/{dd}/*.parquet';
    expect(concretePatterns(pattern, fileWindow(range, needsComparison(url, [])))).toEqual(['s3://logs/2026/09/21/*.parquet', 's3://logs/2026/09/22/*.parquet', 's3://logs/2026/09/23/*.parquet']);
    expect(concretePatterns(pattern, fileWindow(range, false))).not.toContain('s3://logs/2026/09/21/*.parquet');
  });

  it('only requests comparison files for visible, supported charts', () => {
    expect(needsComparison({ ...url, page: 'discover' }, [tile])).toBe(false);
    expect(needsComparison({ ...url, vis: { ...url.vis, chart: 'table' } }, [])).toBe(false);
    expect(needsComparison({ ...url, vis: { ...url.vis, x: { ...url.vis.x, kind: 'terms' } } }, [])).toBe(false);
    const dashboard = { ...url, page: 'dashboard' as const };
    expect(needsComparison(dashboard, [tile])).toBe(true);
    expect(needsComparison(dashboard, [{ ...tile, pinned: false }])).toBe(false);
    expect(needsComparison(dashboard, [{ ...tile, vis: DEFAULT_VIS }])).toBe(false);
  });

  it('notifies file selection when a saved tile is pinned or edited', () => {
    let notifications = 0;
    const unsubscribe = savedVisRevision.subscribe(() => notifications++);
    storeSavedVis([tile]);
    storeSavedVis([{ ...tile, pinned: false }]);
    unsubscribe();
    expect(notifications).toBe(2);
  });
});
