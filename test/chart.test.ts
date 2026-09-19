import { describe, expect, it } from 'vitest';
import { toSeries } from '../src/components/Chart';
import { encodeVisValue, type VisResult } from '../src/queries';
import type { MetricDef } from '../src/state';

describe('toSeries', () => {
  it('does not conflate term and metric names whose space-joined keys match', () => {
    const a = encodeVisValue('a');
    const ab = encodeVisValue('a b');
    const result: VisResult = {
      rows: [
        { x: a, g: null, m: [1, 10] },
        { x: ab, g: null, m: [2, 20] },
      ],
      xKind: 'terms',
      xOrder: [a, ab],
      groups: [],
      interval: null,
      tzOffset: 0,
      step: null,
      sql: '',
    };
    const metrics: MetricDef[] = [
      { id: 'm0', agg: 'count', field: null, label: 'b c' },
      { id: 'm1', agg: 'count', field: null, label: 'c' },
    ];

    const { data } = toSeries(result, metrics);
    expect(data.find((d) => d.x === a && d.s === 'b c')?.y).toBe(1);
    expect(data.find((d) => d.x === ab && d.s === 'c')?.y).toBe(20);
  });
});
