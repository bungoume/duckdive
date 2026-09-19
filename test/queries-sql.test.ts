import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Field } from '../src/fields';
import { DEFAULT_VIS } from '../src/state';

const run = vi.hoisted(() => vi.fn());
vi.mock('../src/duck', () => ({ query: run }));

import { fetchVis } from '../src/queries';

describe('visualization SQL', () => {
  beforeEach(() => run.mockReset().mockResolvedValue({ rows: [], columns: [], ms: 0 }));

  it('matches a null value selected as a top group', async () => {
    const host: Field = { name: 'host', expr: '"host"', kind: 'string', duckType: 'VARCHAR', column: 'host', searchable: true };
    const vis = { ...DEFAULT_VIS, breakdown: { field: 'host', size: 1, other: false } };
    await fetchVis(vis, 'TRUE', null, [host], null, 0, 60);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toContain('topg.g IS NOT DISTINCT FROM base.g');
  });
});
