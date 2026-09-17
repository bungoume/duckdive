import { useEffect, useState } from 'preact/hooks';

/**
 * A counter that advances every `intervalMs` while `enabled`; the pages re-run their search on
 * every change. A tick is skipped while a query is still running or the tab is hidden, so slow
 * queries do not pile up and a background tab costs nothing.
 */
export function useAutoRefresh(intervalMs: number, enabled: boolean, busy: { current: boolean }): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!intervalMs || !enabled) return;
    const id = setInterval(() => {
      if (document.hidden || busy.current) return;
      setTick((n) => n + 1);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled, busy]);
  return tick;
}
