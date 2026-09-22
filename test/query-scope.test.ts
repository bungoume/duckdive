import { describe, expect, it, vi } from 'vitest';
import { createQueryScope } from '../src/queryScope';

describe('query ownership', () => {
  it('supersedes a run and balances each busy notification exactly once', () => {
    const scope = createQueryScope();
    const busy = vi.fn();
    const first = scope.start(busy);
    const second = scope.start(busy);
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    first.finish();
    second.finish();
    scope.cancel();
    scope.cancel();
    expect(second.isCurrent()).toBe(false);
    expect(busy.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it('cancelling one tile does not cancel another tile', () => {
    const left = createQueryScope();
    const right = createQueryScope();
    const first = left.start(() => undefined);
    const second = right.start(() => undefined);
    left.cancel();
    expect(first.signal.aborted).toBe(true);
    expect(second.isCurrent()).toBe(true);
  });
});
