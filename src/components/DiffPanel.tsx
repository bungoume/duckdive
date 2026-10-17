import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatLocal } from '../datemath';
import { query } from '../duck';
import { describeError } from '../errors';
import { findField, type Field } from '../fields';
import { t } from '../i18n';
import { buildDiffQuery, defaultDiffField, diffDrillDown, type DiffPlan, type DiffResult } from '../logDiff';
import { CancelledError } from '../net';
import type { Compiled } from '../queryPlans';
import { createQueryScope } from '../queryScope';
import type { DiffState, SearchState } from '../state';
import { trustSql } from '../trust';

export function DiffPanel(props: {
  settings: DiffState;
  fields: Field[];
  timeExpr: string | null;
  search: SearchState;
  compiled: Compiled;
  onSettings: (s: DiffState) => void;
  onDrillDown: (s: SearchState) => void;
  onBusy: (b: boolean) => void;
  paused?: boolean;
  refreshTick?: number;
}) {
  const { settings, fields, timeExpr, search, compiled, paused, refreshTick } = props;
  const field =
    (settings.field ? findField(fields, settings.field) : undefined) ?? defaultDiffField(fields, settings.mode);
  const plan = useMemo(
    () => (field?.kind === 'string' ? buildDiffQuery(settings, field, fields, timeExpr, search, compiled) : null),
    [settings, field, fields, timeExpr, search, compiled],
  );
  const [result, setResult] = useState<{ plan: DiffPlan; data: DiffResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scope = useRef(createQueryScope()).current;
  const busyCallback = useRef(props.onBusy);
  busyCallback.current = props.onBusy;
  useEffect(() => {
    setResult(null);
    setError(null);
    if (!plan || paused) return;
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
  }, [plan, paused, refreshTick, scope]);
  const data = !paused && result?.plan === plan ? result.data : null;
  const pct = (n: number, total: number) => (total ? `${((n / total) * 100).toFixed(1)}%` : '—');

  return (
    <section class="diff-panel" aria-label={t('diff.title')}>
      <div class="row diff-controls">
        <b>{t('diff.title')}</b>
        <select
          class="input"
          aria-label={t('diff.mode')}
          value={settings.mode}
          onChange={(e) => {
            const mode = e.currentTarget.value === 'urls' ? 'urls' : 'patterns';
            props.onSettings({ ...settings, mode, field: null, errorsOnly: mode === 'patterns' });
          }}
        >
          <option value="patterns">{t('diff.patterns')}</option>
          <option value="urls">{t('diff.urls')}</option>
        </select>
        <select
          class="input"
          aria-label={t('diff.field')}
          value={field?.name ?? ''}
          onChange={(e) => props.onSettings({ ...settings, field: e.currentTarget.value })}
        >
          {!field && <option value="">{t('diff.noField')}</option>}
          {fields
            .filter((f) => f.kind === 'string')
            .map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
        </select>
        <label class="row">
          <input
            type="checkbox"
            checked={settings.errorsOnly}
            onChange={(e) => props.onSettings({ ...settings, errorsOnly: e.currentTarget.checked })}
          />
          {t('diff.errorsOnly')}
        </label>
        <label class="row">
          <input
            type="checkbox"
            checked={settings.newOnly}
            onChange={(e) => props.onSettings({ ...settings, newOnly: e.currentTarget.checked })}
          />
          {t('diff.newOnly')}
        </label>
      </div>
      <p class="hint">{t(settings.mode === 'patterns' ? 'diff.patternHint' : 'diff.urlHint')}</p>
      {settings.errorsOnly && <p class="hint">{t('diff.errorHint')}</p>}
      {plan && (
        <div class="diff-periods hint">
          <span>
            {t('diff.previous')}: {formatLocal(new Date(plan.previousRange.from))} →{' '}
            {formatLocal(new Date(plan.previousRange.to))}
          </span>
          <span>
            {t('diff.current')}: {formatLocal(new Date(plan.currentRange.from))} →{' '}
            {formatLocal(new Date(plan.currentRange.to))}
          </span>
        </div>
      )}
      {!plan && <div class="empty">{compiled.error ?? t('diff.unavailable')}</div>}
      {error && <div class="alert error">{error}</div>}
      {plan && !data && !error && <div class="empty">{t('common.loading')}</div>}
      {data && (
        <>
          <p class="hint">
            {t('diff.summary', {
              previous: data.previousTotal.toLocaleString(),
              current: data.currentTotal.toLocaleString(),
              shown: data.rows.length,
              total: data.totalChanges.toLocaleString(),
            })}
          </p>
          {data.previousTotal === 0 && <div class="alert warn">{t('diff.noBaseline')}</div>}
          {data.rows.length === 0 ? (
            <div class="empty">{t('diff.empty')}</div>
          ) : (
            <div class="diff-table-scroll">
              <table class="data diff-table">
                <thead>
                  <tr>
                    <th>{t('diff.change')}</th>
                    <th>{t(settings.mode === 'patterns' ? 'diff.patterns' : 'diff.urls')}</th>
                    <th class="num">{t('diff.previous')}</th>
                    <th class="num">{t('diff.current')}</th>
                    <th class="num">{t('diff.delta')}</th>
                    <th class="num">{t('diff.growth')}</th>
                    <th>{t('diff.share')}</th>
                    <th>{t('diff.logs')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.value}>
                      <td>
                        <span class={'diff-badge' + (row.previous === 0 ? ' new' : '')}>
                          {t(row.previous === 0 ? 'diff.new' : 'diff.increased')}
                        </span>
                      </td>
                      <td class="diff-value">
                        <div class="mono">{row.value}</div>
                        <div class="hint mono diff-example">{row.example}</div>
                      </td>
                      <td class="num">{row.previous.toLocaleString()}</td>
                      <td class="num">{row.current.toLocaleString()}</td>
                      <td class="num">+{row.delta.toLocaleString()}</td>
                      <td class="num">{row.previous ? `+${((row.delta / row.previous) * 100).toFixed(1)}%` : '—'}</td>
                      <td class="nowrap">
                        {pct(row.previous, data.previousTotal)} → {pct(row.current, data.currentTotal)}
                      </td>
                      <td>
                        <button
                          class="btn small"
                          onClick={() => {
                            if (!plan) return;
                            const next = diffDrillDown(plan, row, search);
                            const filter = next.filters[next.filters.length - 1];
                            if (filter.sql) trustSql(filter.sql);
                            props.onDrillDown(next);
                          }}
                        >
                          {t('diff.logs')}
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
    </section>
  );
}
