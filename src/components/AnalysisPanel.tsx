import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { analysisSearch } from '../analysisTemplates';
import { query } from '../duck';
import { describeError } from '../errors';
import { t } from '../i18n';
import { CancelledError } from '../net';
import type { Compiled, QueryPlan } from '../queryPlans';
import { createQueryScope } from '../queryScope';
import type { Filter } from '../sql';
import type { SearchState } from '../state';
import { trustSql } from '../trust';

export interface AnalysisPanelProps {
  compiled: Compiled;
  search: SearchState;
  onExplore: (search: SearchState, sortField?: string) => void;
  onBusy: (busy: boolean) => void;
  paused?: boolean;
  refreshTick?: number;
}
export type ExploreAnalysis = (filter: Filter, sortField?: string) => void;

/** Shared lifecycle: cancel stale queries, pause on collapse, preserve the analyzed search on drill-down. */
export function AnalysisPanel<T>(
  props: AnalysisPanelProps & {
    title: string;
    plan: QueryPlan<T>;
    children: (data: T, explore: ExploreAnalysis) => ComponentChildren;
  },
) {
  const { compiled, plan, paused, refreshTick } = props;
  const [collapsed, setCollapsed] = useState(false);
  const [result, setResult] = useState<{ plan: typeof plan; data: T } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scope = useRef(createQueryScope()).current;
  const busyCallback = useRef(props.onBusy);
  busyCallback.current = props.onBusy;
  useEffect(() => {
    setResult(null);
    setError(null);
    if (paused || compiled.error || collapsed) return;
    const run = scope.start(busyCallback.current);
    query(plan.sql, run.signal)
      .then((r) => {
        if (run.isCurrent()) setResult({ plan, data: plan.read(r.rows) });
      })
      .catch((e) => {
        if (run.isCurrent() && !(e instanceof CancelledError)) setError(describeError(e));
      })
      .finally(() => run.finish());
    return () => scope.cancel();
  }, [plan, compiled.error, paused, collapsed, refreshTick, scope]);
  const data = !paused && !compiled.error && result?.plan === plan ? result.data : null;
  const explore: ExploreAnalysis = (filter, sortField) => {
    if (filter.sql) trustSql(filter.sql);
    props.onExplore(analysisSearch(props.search, compiled, filter), sortField);
  };
  return (
    <section class="analysis-template" aria-label={props.title}>
      <div class="row">
        <h3>{props.title}</h3>
        <span class="hint">{t('analysis.scope')}</span>
        <span class="grow" />
        <button class="btn small ghost" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
          {t(collapsed ? 'analysis.expand' : 'analysis.collapse')}
        </button>
      </div>
      {!collapsed && (
        <>
          {!compiled.from && <p class="hint">{t('analysis.allTime')}</p>}
          {(compiled.error || error) && <div class="alert error">{compiled.error ?? error}</div>}
          {data === null && !compiled.error && !error && <div class="empty">{t('common.loading')}</div>}
          {data !== null && props.children(data, explore)}
        </>
      )}
    </section>
  );
}
