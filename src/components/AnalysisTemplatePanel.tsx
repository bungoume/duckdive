import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  analysisSearch,
  buildAnalysisQuery,
  cacheResultFilter,
  errorStatusExpr,
  responseTimeExpr,
  slowUrlFilter,
  type AnalysisResult,
  type AnalysisTemplate,
} from '../analysisTemplates';
import { query } from '../duck';
import { describeError } from '../errors';
import { t } from '../i18n';
import { CancelledError } from '../net';
import type { Compiled } from '../queryPlans';
import { createQueryScope } from '../queryScope';
import { newId, type Filter } from '../sql';
import type { SearchState } from '../state';
import { trustSql } from '../trust';
import { fmtDuration } from './ui';

export function AnalysisTemplatePanel(props: {
  template: AnalysisTemplate;
  compiled: Compiled;
  search: SearchState;
  onExplore: (search: SearchState, sortField?: string) => void;
  onBusy: (busy: boolean) => void;
  paused?: boolean;
  refreshTick?: number;
}) {
  const { template, compiled, paused, refreshTick } = props;
  const cloudfront = template.id === 'cloudfront';
  const title = t(cloudfront ? 'analysis.cloudfront.title' : 'analysis.alb.title');
  const [collapsed, setCollapsed] = useState(false);
  const plan = useMemo(() => buildAnalysisQuery(template, compiled), [template, compiled]);
  const [result, setResult] = useState<{ plan: typeof plan; data: AnalysisResult } | null>(null);
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
  const explore = (filter: Filter, sortField?: string) => {
    if (filter.sql) trustSql(filter.sql);
    props.onExplore(analysisSearch(props.search, compiled, filter), sortField);
  };
  const sqlFilter = (sql: string, label: string): Filter => ({ id: newId(), field: '', op: 'query', sql, label });
  return (
    <section class="analysis-template" aria-label={title}>
      <div class="row">
        <h3>{title}</h3>
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
          {!data && !compiled.error && !error && <div class="empty">{t('common.loading')}</div>}
          {data && (
            <>
              <div class={`analysis-metrics${cloudfront ? ' cloudfront' : ''}`}>
                {cloudfront && (
                  <div class="analysis-metric" data-metric="client-errors">
                    <div class="hint">{t('analysis.cloudfront.clientErrorRate')}</div>
                    <strong class="analysis-value">
                      {data.clientErrorRate === null ? '—' : `${data.clientErrorRate.toFixed(2)}%`}
                    </strong>
                    <div class="hint">
                      {t('analysis.cloudfront.clientErrorCount', {
                        errors: data.clientErrors.toLocaleString(),
                        total: data.requests.toLocaleString(),
                      })}
                    </div>
                    <button
                      class="btn small"
                      disabled={!data.clientErrors}
                      onClick={() =>
                        explore(sqlFilter(errorStatusExpr(template, 4), t('analysis.cloudfront.clientErrors')))
                      }
                    >
                      {t('analysis.cloudfront.clientErrors')}
                    </button>
                  </div>
                )}
                <div class="analysis-metric" data-metric="errors">
                  <div class="hint">{t('analysis.alb.errorRate')}</div>
                  <strong class="analysis-value">
                    {data.errorRate === null ? '—' : `${data.errorRate.toFixed(2)}%`}
                  </strong>
                  <div class="hint">
                    {t('analysis.alb.errorCount', {
                      errors: data.errors.toLocaleString(),
                      total: data.requests.toLocaleString(),
                    })}
                  </div>
                  <button
                    class="btn small"
                    disabled={!data.errors}
                    onClick={() => explore(sqlFilter(errorStatusExpr(template), t('analysis.alb.errors')))}
                  >
                    {t('analysis.alb.errors')}
                  </button>
                </div>
                {data.cache && (
                  <div class="analysis-metric" data-metric="cache">
                    <div class="hint">{t('analysis.cloudfront.cacheRate')}</div>
                    <strong class="analysis-value">
                      {data.cache.hitRate === null ? '—' : `${data.cache.hitRate.toFixed(2)}%`}
                    </strong>
                    <div class="hint">
                      {t('analysis.cloudfront.cacheCount', {
                        hits: data.cache.hits.toLocaleString(),
                        total: data.cache.eligible.toLocaleString(),
                        excluded: data.cache.excluded.toLocaleString(),
                      })}
                    </div>
                    <div class="hint">
                      {t('analysis.cloudfront.refreshCount', { n: data.cache.refreshHits.toLocaleString() })}
                    </div>
                    <div class="row">
                      <button
                        class="btn small"
                        disabled={!data.cache.hits}
                        onClick={() => explore(cacheResultFilter(template, 'hit', t('analysis.cloudfront.hits')))}
                      >
                        {t('analysis.cloudfront.hits')}
                      </button>
                      <button
                        class="btn small"
                        disabled={!data.cache.misses}
                        onClick={() => explore(cacheResultFilter(template, 'miss', t('analysis.cloudfront.misses')))}
                      >
                        {t('analysis.cloudfront.misses')}
                      </button>
                    </div>
                  </div>
                )}
                <div class="analysis-metric" data-metric="p95">
                  <div class="hint">{t(cloudfront ? 'analysis.cloudfront.p95' : 'analysis.alb.p95')}</div>
                  <strong class="analysis-value">{data.p95Ms === null ? '—' : fmtDuration(data.p95Ms)}</strong>
                  <div class="hint">
                    {t('analysis.alb.samples', {
                      n: data.measured.toLocaleString(),
                      skipped: (data.requests - data.measured).toLocaleString(),
                    })}
                  </div>
                  <button
                    class="btn small"
                    disabled={data.p95Ms === null}
                    onClick={() => {
                      if (data.p95Ms !== null)
                        explore(
                          sqlFilter(`(${responseTimeExpr(template)}) >= ${data.p95Ms}`, t('analysis.alb.slowest')),
                          template.duration.name,
                        );
                    }}
                  >
                    {t('analysis.alb.slowest')}
                  </button>
                </div>
              </div>
              <p class="hint">{t(cloudfront ? 'analysis.cloudfront.latencyHint' : 'analysis.alb.latencyHint')}</p>
              {cloudfront && <p class="hint">{t('analysis.cloudfront.cacheHint')}</p>}
              {data.unknownStatus > 0 && (
                <p class="hint">{t('analysis.alb.unknownStatus', { n: data.unknownStatus.toLocaleString() })}</p>
              )}
              <div class="row analysis-ranking-head">
                <b>{t('analysis.alb.slowUrls')}</b>
                <span class="hint">{t('analysis.alb.urlHint')}</span>
              </div>
              {data.slowUrls.length === 0 ? (
                <div class="empty">{t(data.requests ? 'analysis.noMeasurements' : 'analysis.empty')}</div>
              ) : (
                <div class="analysis-table-scroll">
                  <table class="data analysis-urls">
                    <thead>
                      <tr>
                        <th>{t('analysis.method')}</th>
                        <th>URL</th>
                        <th class="num">{t('analysis.requests')}</th>
                        <th class="num">{t('analysis.samples')}</th>
                        {cloudfront && <th class="num">4xx</th>}
                        <th class="num">5xx</th>
                        <th class="num">p95</th>
                        <th>{t('analysis.logs')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.slowUrls.map((row) => (
                        <tr key={JSON.stringify([row.method, row.url])}>
                          <td class="mono">{row.method ?? '—'}</td>
                          <td class="mono analysis-url">{row.url}</td>
                          <td class="num">{row.requests.toLocaleString()}</td>
                          <td class="num">{row.measured.toLocaleString()}</td>
                          {cloudfront && <td class="num">{row.clientErrors.toLocaleString()}</td>}
                          <td class="num">{row.errors.toLocaleString()}</td>
                          <td class="num analysis-duration">{fmtDuration(row.p95Ms)}</td>
                          <td>
                            <button
                              class="btn small"
                              onClick={() => explore(slowUrlFilter(template, row), template.duration.name)}
                            >
                              {t('analysis.logs')}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
