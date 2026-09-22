import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SEARCH } from '../src/state';

const run = vi.hoisted(() => vi.fn().mockResolvedValue({ rows: [], columns: [], ms: 1 }));
vi.mock('../src/duck', () => ({ query: run }));
vi.mock('preact/hooks', () => ({
  useState: <T>(initial: T | (() => T)) => [typeof initial === 'function' ? (initial as () => T)() : initial, () => undefined],
  useRef: <T>(initial: T) => ({ current: initial }),
  useEffect: () => undefined,
}));
import { SqlPage } from '../src/components/SqlPage';

type Node = { type: unknown; props: Record<string, unknown> };
function find(node: unknown, type: string): Node | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = find(child, type);
      if (match) return match;
    }
  } else if (node && typeof node === 'object' && 'props' in node) {
    const v = node as Node;
    return v.type === type ? v : find(v.props.children, type);
  }
}

beforeEach(() => {
  localStorage.clear();
  run.mockClear();
});
describe('SQL keyboard execution', () => {
  it.each(['ctrlKey', 'metaKey'])('honors source pause for %s+Enter and runs again when ready', async (modifier) => {
    for (const paused of [true, false]) {
      const onBusy = vi.fn();
      const view = SqlPage({ fields: [], timeExpr: null, search: DEFAULT_SEARCH, onBusy, paused });
      const onKeyDown = find(view, 'textarea')!.props.onKeyDown as (e: object) => void;
      onKeyDown({ key: 'Enter', [modifier]: true, preventDefault: vi.fn() });
      await Promise.resolve();
      if (paused) {
        expect(run).not.toHaveBeenCalled();
        expect(onBusy).not.toHaveBeenCalled();
      } else {
        expect(run).toHaveBeenCalledExactlyOnceWith('SELECT * FROM src LIMIT 100', expect.any(AbortSignal));
        expect(onBusy).toHaveBeenCalledWith(true);
      }
    }
  });
});
