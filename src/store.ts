// A module-level value with subscribers: `get()` reads it anywhere, `set()` replaces it and
// notifies, and `useStore()` re-renders the calling component whenever it changes.

import { useEffect, useState } from 'preact/hooks';

export interface Store<T> {
  get(): T;
  set(value: T): void;
  /** Calls `f` after every set(); returns the unsubscribe function. */
  subscribe(f: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      value = next;
      for (const f of listeners) f();
    },
    subscribe(f) {
      listeners.add(f);
      return () => {
        listeners.delete(f);
      };
    },
  };
}

/** The store's current value; the component re-renders when it changes. */
export function useStore<T>(store: Store<T>): T {
  const [value, setValue] = useState(store.get());
  useEffect(() => {
    const sync = () => setValue(store.get());
    sync(); // a change between the first render and this subscription
    return store.subscribe(sync);
  }, [store]);
  return value;
}
