import { timeContext } from '../src/datemath';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SEARCH, DEFAULT_VIS } from '../src/state';
import type { VisResult } from '../src/queries';

const hook = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, cleanup: undefined as (() => void) | undefined, deps: undefined as unknown[] | undefined }));
vi.mock('preact/hooks', () => ({
  useState: <T>(initial: T) => {
    const i = hook.cursor++;
    if (!(i in hook.slots)) hook.slots[i] = initial;
    return [
      hook.slots[i],
      (value: T) => {
        hook.slots[i] = value;
      },
    ];
  },
  useRef: <T>(initial: T) => {
    const i = hook.cursor++;
    return (hook.slots[i] ??= { current: initial });
  },
  useMemo: <T>(get: () => T, deps: unknown[]) => {
    const i = hook.cursor++;
    const previous = hook.slots[i] as { value: T; deps: unknown[] } | undefined;
    if (!previous || !deps.every((d, j) => Object.is(d, previous.deps[j]))) hook.slots[i] = { value: get(), deps };
    return (hook.slots[i] as { value: T }).value;
  },
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    if (hook.deps && deps.every((d, i) => Object.is(d, hook.deps![i]))) return;
    hook.cleanup?.();
    hook.deps = deps;
    hook.cleanup = effect();
  },
}));
const fetch = vi.hoisted(() => vi.fn());
vi.mock('../src/queries', async (original) => ({ ...(await original<object>()), fetchVis: fetch }));
import { useVisQuery } from '../src/hooks/useVisQuery';

type Input = Parameters<typeof useVisQuery>[0];
let input: Input;
function TestQuery(patch: Partial<Input> = {}) {
  input = { ...input, ...patch };
  hook.cursor = 0;
  return useVisQuery(input);
}
const result = (x: number): VisResult => ({ rows: [{ x, g: null, m: [1] }], xKind: 'date_histogram', xOrder: [x], groups: [], interval: null, tzOffset: 0, step: null, sql: '' });
const drain = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => {
  hook.slots = [];
  hook.deps = undefined;
  hook.cleanup = undefined;
  fetch.mockReset();
  input = {
    vis: DEFAULT_VIS,
    compiled: { context: timeContext(), where: 'TRUE', error: null, from: new Date('2026-09-22T01:00:00Z'), to: new Date('2026-09-22T02:00:00Z') },
    searches: [DEFAULT_SEARCH],
    fields: [],
    timeExpr: 'ts',
    targetBuckets: 50,
    onBusy: vi.fn(),
  };
});
afterEach(() => {
  hook.cleanup?.();
  vi.useRealTimers();
});

describe('shared visualization queries', () => {
  it('discards an obsolete result and balances busy notifications once per run', async () => {
    const finishes: ((r: VisResult) => void)[] = [];
    fetch.mockImplementation(() => new Promise<VisResult>((resolve) => finishes.push(resolve)));
    TestQuery();
    TestQuery({ compiled: { ...input.compiled, where: 'FALSE' } });
    finishes[0](result(1));
    await drain();
    expect(TestQuery().result).toBeNull();
    expect(TestQuery().busy).toBe(true);
    finishes[1](result(2));
    await drain();
    expect(TestQuery().result).toEqual(result(2));
    expect(TestQuery().busy).toBe(false);
    expect(vi.mocked(input.onBusy).mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it.each(['pause', 'unmount', 'invalid search'])('ignores a pending result after %s', async (reason) => {
    let finish!: (r: VisResult) => void;
    fetch.mockImplementation(
      () =>
        new Promise<VisResult>((resolve) => {
          finish = resolve;
        }),
    );
    TestQuery();
    if (reason === 'pause') TestQuery({ paused: true });
    else if (reason === 'invalid search') TestQuery({ compiled: { ...input.compiled, error: 'invalid' } });
    else hook.cleanup?.();
    finish(result(1));
    await drain();
    expect(TestQuery().result).toBeNull();
    expect(vi.mocked(input.onBusy).mock.calls).toEqual([[true], [false]]);
  });

  it('does not re-query presentation changes, but refreshes on a tick', async () => {
    fetch.mockResolvedValue(result(1));
    TestQuery();
    await drain();
    TestQuery({ vis: { ...DEFAULT_VIS, title: 'Renamed', chart: 'area', metrics: [{ ...DEFAULT_VIS.metrics[0], label: 'Records' }] }, onBusy: vi.fn() });
    expect(fetch).toHaveBeenCalledOnce();
    TestQuery({ refreshTick: 1 });
    await drain();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not advance relative query dates on an unrelated render', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T02:00:00Z'));
    fetch.mockResolvedValue(result(1));
    TestQuery({
      vis: { ...DEFAULT_VIS, compare: true },
      searches: [{ ...DEFAULT_SEARCH, query: 'ts:>now-1h' }],
      fields: [{ name: 'ts', column: 'ts', expr: 'ts', kind: 'date', duckType: 'TIMESTAMP', searchable: false }],
    });
    await drain();
    vi.setSystemTime(new Date('2026-09-22T02:00:01Z'));
    TestQuery();
    expect(fetch).toHaveBeenCalledTimes(2);
    TestQuery({ refreshTick: 1, compiled: { ...input.compiled, context: timeContext() } });
    await drain();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('fetches the preceding period and shifts its buckets by the range length', async () => {
    const x = Date.UTC(2026, 8, 22);
    fetch.mockResolvedValueOnce(result(x + 3600000)).mockResolvedValueOnce(result(x));
    TestQuery({ vis: { ...DEFAULT_VIS, compare: true } });
    await drain();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1]).toContain('2026-09-22 00:00:00');
    expect(TestQuery().previous?.rows[0].x).toBe(x + 3600000);
  });
});
