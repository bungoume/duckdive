import { describe, expect, it } from 'vitest';
import { searchAfterPick } from '../src/components/visutil';
import { NULL_GROUP, OTHER, encodeVisValue } from '../src/queries';
import { DEFAULT_SEARCH, DEFAULT_VIS, type VisState } from '../src/state';

const pick = (p: Partial<Parameters<typeof searchAfterPick>[2]>) => ({ x: 'a', series: 'Count', value: 1, isTime: false, intervalMs: 0, ...p });

describe('searchAfterPick', () => {
  it('turns breakdown values into filters without confusing labels with sentinels', () => {
    const vis: VisState = { ...DEFAULT_VIS, breakdown: { field: 'level', size: 2, other: true } };
    const groups = [encodeVisValue('error'), encodeVisValue('Other'), NULL_GROUP, OTHER];
    expect(searchAfterPick(vis, groups, pick({ series: encodeVisValue('Other') }), DEFAULT_SEARCH)?.filters).toMatchObject([{ field: 'level', op: 'is', value: 'Other' }]);
    expect(searchAfterPick(vis, groups, pick({ series: NULL_GROUP }), DEFAULT_SEARCH)?.filters).toMatchObject([{ field: 'level', op: 'does_not_exist' }]);
    expect(searchAfterPick(vis, groups, pick({ series: OTHER }), DEFAULT_SEARCH)?.filters).toMatchObject([
      { field: 'level', op: 'is_not_one_of', values: ['error', 'Other'] },
      { field: 'level', op: 'exists' },
    ]);
  });

  it('turns a terms bucket into a filter and a time bucket into the range', () => {
    const terms: VisState = { ...DEFAULT_VIS, x: { ...DEFAULT_VIS.x, kind: 'terms', field: 'host' } };
    expect(searchAfterPick(terms, [], pick({ x: encodeVisValue('(null)') }), DEFAULT_SEARCH)?.filters).toMatchObject([{ field: 'host', op: 'is', value: '(null)' }]);
    expect(searchAfterPick(terms, [], pick({ x: NULL_GROUP }), DEFAULT_SEARCH)?.filters).toMatchObject([{ field: 'host', op: 'does_not_exist' }]);
    const t0 = new Date('2026-09-17T00:00:00Z');
    const zoomed = searchAfterPick(DEFAULT_VIS, [], pick({ x: t0, isTime: true, intervalMs: 3600_000 }), DEFAULT_SEARCH);
    expect(zoomed?.range).toEqual({ from: '2026-09-17T00:00:00.000Z', to: '2026-09-17T01:00:00.000Z' });
  });

  it('means nothing for a histogram bucket', () => {
    const hist: VisState = { ...DEFAULT_VIS, x: { ...DEFAULT_VIS.x, kind: 'histogram', field: 'bytes' } };
    expect(searchAfterPick(hist, [], pick({ x: 100 }), DEFAULT_SEARCH)).toBeNull();
  });
});
