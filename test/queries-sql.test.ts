import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Field } from '../src/fields';
import { DEFAULT_VIS } from '../src/state';

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
});
