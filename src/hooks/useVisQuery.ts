import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { supportsComparison } from '../comparison';
import { describeError } from '../errors';
import type { Field } from '../fields';
import { CancelledError } from '../net';
import { fetchVis, previousPeriodWhere, shiftVisResult, type Compiled, type VisResult } from '../queries';
import { autoInterval, bucketOffsetMinutes, intervalByKey } from '../sql';
import type { SearchState, VisState } from '../state';

/** Aggregation and comparison lifecycle shared by Visualize and dashboard tiles. */
export function useVisQuery({
  vis,
  compiled,
  searches,
  fields,
  timeExpr,
  targetBuckets,
  onBusy,
  paused,
  refreshTick,
}: {
  vis: VisState;
  compiled: Compiled;
  searches: SearchState[];
  fields: Field[];
  timeExpr: string | null;
  targetBuckets: number;
  onBusy: (busy: boolean) => void;
  paused?: boolean;
  refreshTick?: number;
}) {
  const effective: VisState = vis.chart === 'metric' ? { ...vis, x: { ...vis.x, kind: 'none' } } : vis;
  const interval = compiled.from && compiled.to ? (intervalByKey(vis.x.interval) ?? autoInterval(compiled.from, compiled.to, targetBuckets)) : null;
  const tzOffset = bucketOffsetMinutes(compiled.to ?? undefined);
  const spanMs = compiled.from && compiled.to ? Math.max(0, compiled.to.getTime() - compiled.from.getTime()) : 0;
  const compare = supportsComparison(vis);
  const searchKey = JSON.stringify(searches);
  const { from, to } = compiled;
  // Relative dates inside queries/filters must not advance on a busy-state render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const previousWhere = useMemo(() => previousPeriodWhere(vis, compiled, searches, fields, timeExpr), [compare, from, to, searchKey, fields, timeExpr, refreshTick]);
  // Presentation changes (title, labels, line/area style) do not change the aggregation.
  const queryKey = JSON.stringify([effective.x, effective.metrics.map((m) => [m.agg, m.field, m.param]), effective.breakdown]);
  const [result, setResult] = useState<VisResult | null>(null);
  const [previous, setPrevious] = useState<VisResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyCallback = useRef(onBusy);
  busyCallback.current = onBusy;

  useEffect(() => {
    if (compiled.error || paused) {
      setBusy(false);
      return;
    }
    let live = true;
    let pending = true;
    const report = busyCallback.current;
    // Balance each start exactly once, including removal of an in-flight dashboard tile.
    const finish = () => {
      if (!pending) return;
      pending = false;
      report(false);
    };
    setBusy(true);
    report(true);
    setError(null);
    Promise.all([
      fetchVis(effective, compiled.where, timeExpr, fields, interval, tzOffset, spanMs / 1000),
      previousWhere ? fetchVis(effective, previousWhere, timeExpr, fields, interval, tzOffset, spanMs / 1000) : Promise.resolve(null),
    ])
      .then(([current, prior]) => {
        if (!live) return;
        setResult(current);
        setPrevious(shiftVisResult(prior, spanMs));
      })
      .catch((e) => {
        if (live && !(e instanceof CancelledError)) setError(describeError(e));
      })
      .finally(() => {
        if (live) setBusy(false);
        finish();
      });
    return () => {
      live = false;
      finish();
    };
    // Definitions are compared by queryKey; refreshTick also refreshes an absolute range.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiled.where, compiled.error, previousWhere, queryKey, interval?.key, tzOffset, timeExpr, fields, spanMs, paused, refreshTick]);

  return { result, previous, busy, error, interval, compare: previousWhere !== null };
}
