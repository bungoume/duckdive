import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Field } from '../src/fields';
import { DEFAULT_VIS } from '../src/state';
import { intervalByKey } from '../src/sql';

const run = vi.hoisted(() => vi.fn());
vi.mock('../src/duck', () => ({ query: run }));

import { NULL_GROUP, OTHER, encodeVisValue, fetchVis, groupLabel } from '../src/queries';

describe('visualization SQL', () => {
  beforeEach(() => run.mockReset().mockResolvedValue({ rows: [], columns: [], ms: 0 }));

  it('matches a null value selected as a top group', async () => {
    const host: Field = { name: 'host', expr: '"host"', kind: 'string', duckType: 'VARCHAR', column: 'host', searchable: true };
    const vis = { ...DEFAULT_VIS, breakdown: { field: 'host', size: 1, other: false } };
    await fetchVis(vis, 'TRUE', null, [host], null, 0, 60);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toContain('topg.g IS NOT DISTINCT FROM base.g');
  });

  it('keeps null and reserved-looking values as distinct terms and groups', async () => {
    run.mockResolvedValueOnce({
      rows: [
        { x: null, g: null, __other: false, m0: 3, xr: 1 },
        { x: '(null)', g: 'Other', __other: false, m0: 2, xr: 2 },
        { x: 'Other', g: null, __other: true, m0: 1, xr: 3 },
      ],
      columns: [],
      ms: 0,
    });
    const host: Field = { name: 'host', expr: '"host"', kind: 'string', duckType: 'VARCHAR', column: 'host', searchable: true };
    const level: Field = { name: 'level', expr: '"level"', kind: 'string', duckType: 'VARCHAR', column: 'level', searchable: true };
    const vis = { ...DEFAULT_VIS, x: { ...DEFAULT_VIS.x, kind: 'terms' as const, field: 'host', size: 3 }, breakdown: { field: 'level', size: 2, other: true } };
    const result = await fetchVis(vis, 'TRUE', null, [host, level], null, 0, 60);

    expect(run.mock.calls[0][0]).toContain('topx.x IS NOT DISTINCT FROM base.x');
    expect(run.mock.calls[0][0]).toContain('AS __other');
    expect(result.xOrder).toEqual([NULL_GROUP, encodeVisValue('(null)'), encodeVisValue('Other')]);
    expect(result.groups).toEqual([NULL_GROUP, encodeVisValue('Other'), OTHER]);
    expect(result.rows.map((row) => [groupLabel(String(row.x)), groupLabel(row.g!)])).toEqual([
      ['(null)', '(null)'],
      ['"(null)"', '"Other"'],
      ['"Other"', 'Other'],
    ]);
  });

  it('uses the actual length of calendar buckets for rates', async () => {
    const jan = Date.UTC(2028, 0, 1);
    const feb = Date.UTC(2028, 1, 1);
    run.mockResolvedValueOnce({
      rows: [
        { x: jan, g: null, m0: 2_678_400 },
        { x: feb, g: null, m0: 2_505_600 },
      ],
      columns: [],
      ms: 0,
    });
    const vis = { ...DEFAULT_VIS, metrics: [{ id: 'rate', agg: 'rate' as const, field: null }] };
    const result = await fetchVis(vis, 'TRUE', '"ts"', [], intervalByKey('1M')!, 0, 60);

    expect(run.mock.calls[0][0]).toContain('(count(*)::DOUBLE / 1) AS m0');
    expect(result.rows.map((row) => row.m[0])).toEqual([1, 1]);
  });

  it('bounds top-N limits again when called with unsanitized state', async () => {
    const host: Field = { name: 'host', expr: '"host"', kind: 'string', duckType: 'VARCHAR', column: 'host', searchable: true };
    const vis = { ...DEFAULT_VIS, x: { ...DEFAULT_VIS.x, kind: 'terms' as const, field: 'host', size: 1e100 }, breakdown: { field: 'host', size: 1e100, other: true } };
    await fetchVis(vis, 'TRUE', null, [host], null, 0, 60);
    expect(run.mock.calls[0][0]).toContain('LIMIT 500');
    expect(run.mock.calls[0][0]).toContain('LIMIT 50');
  });

  it('treats a non-finite numeric histogram interval as automatic', async () => {
    run.mockResolvedValueOnce({ rows: [{ mn: 0, mx: 100 }], columns: [], ms: 0 }).mockResolvedValueOnce({ rows: [], columns: [], ms: 0 });
    const bytes: Field = { name: 'bytes', expr: '"bytes"', kind: 'number', duckType: 'DOUBLE', column: 'bytes', searchable: false };
    const vis = { ...DEFAULT_VIS, x: { ...DEFAULT_VIS.x, kind: 'histogram' as const, field: 'bytes', interval: '1e309' } };
    const result = await fetchVis(vis, 'TRUE', null, [bytes], null, 0, 60);
    expect(result.step).toBe(2);
    expect(run.mock.calls[1][0]).not.toContain('Infinity');
  });
});
