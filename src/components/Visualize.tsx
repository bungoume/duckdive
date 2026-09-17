import { describeError } from '../errors';
import { CancelledError } from '../net';
import { formatDate } from '../datefmt';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { TimeRange } from '../datemath';
import type { Field } from '../fields';
import { findField } from '../fields';
import { compileSearch, fetchVis, metricLabel, type VisResult } from '../queries';
import { INTERVALS, autoInterval, bucketOffsetMinutes, intervalByKey, intervalLabel, newId, type Filter, type Interval } from '../sql';
import { t } from '../i18n';
import { loadSavedVis, storeSavedVis, type ChartType, type MetricAgg, type MetricDef, type SavedVis, type SearchState, type VisState } from '../state';
import { Chart, type ChartPick } from './Chart';
import { DataTable, MetricTiles } from './VisTable';
import { FieldSidebar } from './FieldSidebar';
import { FilterBar } from './FilterBar';
import { DiagnosePanel } from './DiagnosePanel';
import { QueryBar } from './QueryBar';
import { withCacheHint } from '../diagnose';
import { downloadBlob } from '../export';
import { FormField } from './ui';
import { breakdownLabel, searchAfterPick, xAxisLabel } from './visutil';

const CHARTS: { id: ChartType; icon: string }[] = [
  { id: 'area', icon: '⛰' },
  { id: 'line', icon: '📈' },
  { id: 'bar', icon: '📊' },
  { id: 'table', icon: '▦' },
  { id: 'metric', icon: '🔢' },
];
const chartLabel = (id: ChartType) => t(`vis.chart.${id}`);

const AGGS: { id: MetricAgg; needsField: boolean }[] = [
  { id: 'count', needsField: false },
  { id: 'sum', needsField: true },
  { id: 'avg', needsField: true },
  { id: 'min', needsField: true },
  { id: 'max', needsField: true },
  { id: 'median', needsField: true },
  { id: 'p95', needsField: true },
  { id: 'p99', needsField: true },
  { id: 'percentile', needsField: true },
  { id: 'unique', needsField: true },
  { id: 'rate', needsField: false },
];
const aggLabel = (id: MetricAgg) => t(`vis.agg.${id}`);

function DropZone(props: { onDrop: (name: string) => void; children: preact.ComponentChildren; filled: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <div
      class={'dim' + (props.filled ? ' filled' : '') + (over ? ' over' : '')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const name = e.dataTransfer?.getData('text/field');
        if (name) props.onDrop(name);
      }}
    >
      {props.children}
    </div>
  );
}

function FieldSelect(props: { id?: string; fields: Field[]; value: string | null; onChange: (v: string | null) => void; allow?: (f: Field) => boolean; placeholder?: string }) {
  return (
    <select id={props.id} class="input" value={props.value ?? ''} onChange={(e) => props.onChange(e.currentTarget.value || null)}>
      <option value="">{props.placeholder ?? t('vis.selectField')}</option>
      {props.fields
        .filter((f) => f.kind !== 'object' && (!props.allow || props.allow(f)))
        .map((f) => (
          <option value={f.name}>{f.name}</option>
        ))}
    </select>
  );
}

export function Visualize(props: {
  fields: Field[];
  timeField: Field | null;
  timeExpr: string | null;
  search: SearchState;
  vis: VisState;
  onSearch: (s: SearchState) => void;
  onVis: (v: VisState) => void;
  onBusy: (b: boolean) => void;
  /** true while the file list is being re-resolved: skip queries against the stale view */
  paused?: boolean;
  /** advances on auto refresh: the search is compiled (now resolved) and run again */
  refreshTick?: number;
}) {
  const { fields, timeExpr, search, vis, onBusy, paused, refreshTick } = props;
  // refreshTick is not read: a new tick re-resolves `now` in the range
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const compiled = useMemo(() => compileSearch(search, fields, timeExpr), [search, fields, timeExpr, refreshTick]);
  const effVis: VisState = vis.chart === 'metric' ? { ...vis, x: { ...vis.x, kind: 'none' } } : vis;
  const interval: Interval | null = useMemo(() => {
    if (!compiled.from || !compiled.to) return null;
    return vis.x.interval === 'auto' ? autoInterval(compiled.from, compiled.to, 50) : (intervalByKey(vis.x.interval) ?? autoInterval(compiled.from, compiled.to, 50));
  }, [compiled, vis.x.interval]);

  // buckets are aligned with the display time zone (a settings change re-renders the app, so this follows it)
  const tzOffset = bucketOffsetMinutes(compiled.to ?? undefined);

  const [result, setResult] = useState<VisResult | null>(null);
  /** the previous period, its buckets shifted onto this period's (compare mode) */
  const [previous, setPrevious] = useState<VisResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [saved, setSaved] = useState<SavedVis[]>(() => loadSavedVis());
  const runId = useRef(0);
  const visKey = JSON.stringify(effVis);
  const spanMs = compiled.from && compiled.to ? compiled.to.getTime() - compiled.from.getTime() : 0;
  const isTimeChart = vis.x.kind === 'date_histogram' && (vis.chart === 'area' || vis.chart === 'line' || vis.chart === 'bar');
  const compare = !!vis.compare && isTimeChart && spanMs > 0;
  // the same search over the period of the same length just before this one
  const previousWhere = useMemo(() => {
    if (!compare || !compiled.from || !compiled.to) return null;
    const range = { from: new Date(compiled.from.getTime() - spanMs).toISOString(), to: new Date(compiled.to.getTime() - spanMs).toISOString() };
    return compileSearch({ ...search, range }, fields, timeExpr).where;
  }, [compare, compiled.from, compiled.to, spanMs, search, fields, timeExpr]);

  useEffect(() => {
    if (compiled.error || paused) return;
    const id = ++runId.current;
    setBusy(true);
    onBusy(true);
    setError(null);
    Promise.all([
      fetchVis(effVis, compiled.where, timeExpr, fields, interval, tzOffset, spanMs / 1000),
      previousWhere ? fetchVis(effVis, previousWhere, timeExpr, fields, interval, tzOffset, spanMs / 1000) : Promise.resolve(null),
    ])
      .then(([r, p]) => {
        if (id !== runId.current) return;
        setResult(r);
        setPrevious(
          p ? { ...p, rows: p.rows.map((row) => ({ ...row, x: typeof row.x === 'number' ? row.x + spanMs : row.x })), xOrder: p.xOrder.map((x) => (typeof x === 'number' ? x + spanMs : x)) } : null,
        );
      })
      .catch((e) => {
        if (id === runId.current && !(e instanceof CancelledError)) setError(withCacheHint(describeError(e)));
      })
      .finally(() => {
        if (id === runId.current) {
          setBusy(false);
          onBusy(false);
        }
      });
    // the chart definition and the interval are compared by value, so a restored URL with the same content does not re-query;
    // refreshTick re-runs an unchanged search (absolute range) on auto refresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiled.where, previousWhere, compiled.error, visKey, interval?.key, tzOffset, timeExpr, paused, onBusy, refreshTick]);

  const setVis = (patch: Partial<VisState>) => props.onVis({ ...vis, ...patch });
  const setX = (patch: Partial<VisState['x']>) => setVis({ x: { ...vis.x, ...patch } });
  const setMetric = (id: string, patch: Partial<MetricDef>) => setVis({ metrics: vis.metrics.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  const addMetric = (m?: Partial<MetricDef>) => setVis({ metrics: [...vis.metrics, { id: newId(), agg: 'count', field: null, ...m }] });
  const removeMetric = (id: string) => vis.metrics.length > 1 && setVis({ metrics: vis.metrics.filter((m) => m.id !== id) });
  const setBreakdown = (patch: Partial<VisState['breakdown']>) => setVis({ breakdown: { ...vis.breakdown, ...patch } });

  const dropX = (name: string) => {
    const f = findField(fields, name);
    if (!f) return;
    if (f.kind === 'date') setX({ kind: 'date_histogram', field: f.name });
    else if (f.kind === 'number') setX({ kind: 'histogram', field: f.name, interval: vis.x.kind === 'histogram' ? vis.x.interval : '10' });
    else setX({ kind: 'terms', field: f.name });
  };
  const dropY = (name: string, id?: string) => {
    const f = findField(fields, name);
    if (!f) return;
    const def: Partial<MetricDef> = f.kind === 'number' ? { agg: 'avg', field: f.name } : { agg: 'unique', field: f.name };
    if (id) setMetric(id, def);
    else addMetric(def);
  };
  const dropG = (name: string) => setBreakdown({ field: name });

  const addFilter = (field: string, value: string | null, negate: boolean) => {
    const fl: Filter = value === null ? { id: newId(), field, op: 'does_not_exist', negate } : { id: newId(), field, op: 'is', value, negate };
    props.onSearch({ ...search, filters: [...search.filters, fl] });
  };
  const submit = (query: string, range: TimeRange) => props.onSearch({ ...search, query, range });
  const onBrush = (from: Date, to: Date) => props.onSearch({ ...search, range: { from: from.toISOString(), to: to.toISOString() } });
  /** Click on the chart: breakdown value → filter, terms bucket → filter, time bucket → zoom. */
  const onPick = (pick: ChartPick) => {
    const next = searchAfterPick(vis, result?.groups ?? [], pick, search);
    if (next) props.onSearch(next);
  };

  const save = () => {
    const title = vis.title.trim() || t('vis.visualizationN', { n: saved.length + 1 });
    const existing = saved.find((s) => s.title === title);
    const item: SavedVis = { id: existing?.id ?? newId(), title, savedAt: new Date().toISOString(), vis: { ...vis, title }, search };
    const list = existing ? saved.map((s) => (s.id === existing.id ? item : s)) : [...saved, item];
    setSaved(list);
    storeSavedVis(list);
    setVis({ title });
  };
  const load = (s: SavedVis) => {
    props.onVis(s.vis);
    props.onSearch({ ...search, query: s.search.query, filters: s.search.filters });
  };
  const del = (id: string) => {
    const list = saved.filter((s) => s.id !== id);
    setSaved(list);
    storeSavedVis(list);
  };

  const xLabel = xAxisLabel(vis, interval, props.timeField?.name ?? null);
  const gLabel = breakdownLabel(vis);

  /** The chart's own <svg> (Plot renders small legend swatches before it) as a file. */
  const downloadSvg = () => {
    let best: SVGSVGElement | null = null;
    for (const el of document.querySelectorAll<SVGSVGElement>('.vis-panel .chart-box svg')) if (!best || el.clientWidth > best.clientWidth) best = el;
    if (!best) return;
    const clone = best.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    downloadBlob(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }), `duckdive-${vis.title.trim() || 'chart'}.svg`);
  };

  return (
    <div class="page">
      <div class="topbar">
        <QueryBar query={search.query} range={search.range} error={compiled.error ?? error} busy={busy} fields={fields} onSubmit={submit} />
        <DiagnosePanel error={error} />
        <FilterBar filters={search.filters} fields={fields} onChange={(filters) => props.onSearch({ ...search, filters })} />
      </div>
      {busy && <div class="loading-bar" />}
      <div class="visualize">
        <FieldSidebar fields={fields} selected={[]} where={compiled.where} mode="visualize" onAddFilter={addFilter} />
        <div class="center">
          <div class="canvas">
            <div class="vis-panel">
              <div class="row mb8">
                <input class="input" style="font-weight:600;flex:1" placeholder={t('vis.untitled')} value={vis.title} onInput={(e) => setVis({ title: e.currentTarget.value })} />
                <button class="btn small" onClick={() => setShowSql(!showSql)}>
                  {showSql ? t('vis.hideSql') : t('vis.showSql')}
                </button>
                {result && (vis.chart === 'area' || vis.chart === 'line' || vis.chart === 'bar') && result.xKind !== 'none' && (
                  <button class="btn small" onClick={downloadSvg} title={t('vis.downloadSvg.title')}>
                    {t('vis.downloadSvg')}
                  </button>
                )}
                <button class="btn primary small" onClick={save}>
                  {t('common.save')}
                </button>
              </div>
              {showSql && result && <div class="sql-box mb8">{result.sql}</div>}
              {result && vis.chart === 'table' && <DataTable result={result} metrics={vis.metrics} xLabel={xLabel} gLabel={gLabel} />}
              {result && vis.chart === 'metric' && <MetricTiles result={result} metrics={vis.metrics} />}
              {result && (vis.chart === 'area' || vis.chart === 'line' || vis.chart === 'bar') && (
                <>
                  {result.xKind === 'none' ? (
                    <div class="empty">
                      <h3>{t('vis.chooseAxis.title')}</h3>
                      <p>{t('vis.chooseAxis.text', { axis: t('vis.xAxis') })}</p>
                    </div>
                  ) : (
                    <Chart
                      result={result}
                      metrics={vis.metrics}
                      chart={vis.chart}
                      onBrush={onBrush}
                      onPick={onPick}
                      height={380}
                      percent={vis.percent}
                      log={vis.log}
                      compare={compare ? previous : null}
                    />
                  )}
                  {result.groups.length > 0 && vis.metrics.length > 1 && <div class="legend-note">{t('vis.breakdownNote')}</div>}
                  {compare && previous && <div class="legend-note">{t('vis.previousNote')}</div>}
                </>
              )}
              {!result && !error && <div class="empty">{t('common.loading')}</div>}
            </div>
          </div>
        </div>
        <div class="config">
          <div class="cfg-section">
            <div class="head">{t('vis.type')}</div>
            <div class="body">
              <div class="chart-types">
                {CHARTS.map((c) => (
                  <button key={c.id} class={vis.chart === c.id ? 'active' : ''} aria-pressed={vis.chart === c.id} onClick={() => setVis({ chart: c.id })} title={chartLabel(c.id)}>
                    <span class="ic">{c.icon}</span>
                    {chartLabel(c.id)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {vis.chart !== 'metric' && (
            <div class="cfg-section">
              <div class="head">
                {t('vis.xAxis')}
                {vis.x.kind !== 'none' && (
                  <button class="btn ghost small" onClick={() => setX({ kind: 'none', field: null })}>
                    {t('vis.clear')}
                  </button>
                )}
              </div>
              <div class="body">
                <DropZone filled={vis.x.kind !== 'none'} onDrop={dropX}>
                  <span class="lbl">
                    {vis.x.kind === 'none' ? t('vis.dropHere') : xLabel}
                    <span class="sub">{vis.x.kind === 'none' ? t('vis.orPickBelow') : t(`vis.sub.${vis.x.kind}`)}</span>
                  </span>
                </DropZone>
                <FormField label={t('vis.function')}>
                  <select
                    class="input"
                    value={vis.x.kind}
                    onChange={(e) => {
                      // a field that does not fit the new function (a path on a date histogram) is dropped
                      const kind = e.currentTarget.value as VisState['x']['kind'];
                      const f = vis.x.field ? findField(fields, vis.x.field) : undefined;
                      const fits = !f || (kind === 'date_histogram' ? f.kind === 'date' : kind === 'histogram' ? f.kind === 'number' : true);
                      setX({ kind, field: fits ? vis.x.field : null });
                    }}
                  >
                    <option value="none">–</option>
                    <option value="date_histogram">{t('vis.fn.dateHistogram')}</option>
                    <option value="terms">{t('vis.fn.terms')}</option>
                    <option value="histogram">{t('vis.fn.histogram')}</option>
                  </select>
                </FormField>
                {vis.x.kind === 'date_histogram' && (
                  <>
                    <FormField label={t('common.field')}>
                      <FieldSelect
                        fields={fields}
                        value={vis.x.field}
                        onChange={(v) => setX({ field: v })}
                        allow={(f) => f.kind === 'date'}
                        placeholder={t('vis.timeFieldPlaceholder', { name: props.timeField?.name ?? t('common.none') })}
                      />
                    </FormField>
                    <FormField label={t('vis.minInterval')}>
                      <select class="input" value={vis.x.interval} onChange={(e) => setX({ interval: e.currentTarget.value })}>
                        <option value="auto">{t('common.auto')}</option>
                        {INTERVALS.map((iv) => (
                          <option key={iv.key} value={iv.key}>
                            {intervalLabel(iv)}
                          </option>
                        ))}
                      </select>
                    </FormField>
                  </>
                )}
                {vis.x.kind === 'terms' && (
                  <>
                    <FormField label={t('common.field')}>
                      <FieldSelect fields={fields} value={vis.x.field} onChange={(v) => setX({ field: v })} />
                    </FormField>
                    <div class="row">
                      <FormField label={t('vis.numValues')} class="grow">
                        <input class="input" type="number" min={1} max={500} value={vis.x.size} onInput={(e) => setX({ size: Number(e.currentTarget.value) || 10 })} />
                      </FormField>
                      <FormField label={t('vis.rankBy')} class="grow">
                        <select class="input" value={vis.x.orderBy} onChange={(e) => setX({ orderBy: e.currentTarget.value as 'metric' | 'alpha' })}>
                          <option value="metric">{metricLabel(vis.metrics[0])}</option>
                          <option value="alpha">{t('vis.alphabetical')}</option>
                        </select>
                      </FormField>
                      <FormField label={t('vis.direction')} style="width:90px">
                        <select class="input" value={vis.x.orderDir} onChange={(e) => setX({ orderDir: e.currentTarget.value as 'asc' | 'desc' })}>
                          <option value="desc">{t('vis.desc')}</option>
                          <option value="asc">{t('vis.asc')}</option>
                        </select>
                      </FormField>
                    </div>
                  </>
                )}
                {vis.x.kind === 'histogram' && (
                  <>
                    <FormField label={t('common.field')}>
                      <FieldSelect fields={fields} value={vis.x.field} onChange={(v) => setX({ field: v })} allow={(f) => f.kind === 'number'} />
                    </FormField>
                    <FormField label={t('vis.bucketSize')}>
                      <input class="input" type="number" min={0} step="any" value={vis.x.interval === 'auto' ? 10 : vis.x.interval} onInput={(e) => setX({ interval: e.currentTarget.value })} />
                    </FormField>
                  </>
                )}
              </div>
            </div>
          )}

          <div class="cfg-section">
            <div class="head">
              {vis.chart === 'metric' ? t('vis.metrics') : t('vis.yAxis')}
              <button class="btn ghost small" onClick={() => addMetric()}>
                {t('vis.add')}
              </button>
            </div>
            <div class="body">
              {vis.metrics.map((m) => {
                const agg = AGGS.find((a) => a.id === m.agg)!;
                return (
                  <div key={m.id} class="cfg-section" style="border-style:dashed">
                    <div class="body">
                      <DropZone filled={true} onDrop={(name) => dropY(name, m.id)}>
                        <span class="lbl">
                          {metricLabel(m)}
                          <span class="sub">{t('vis.dropToChange')}</span>
                        </span>
                        {vis.metrics.length > 1 && (
                          <button class="x" onClick={() => removeMetric(m.id)} title={t('common.remove')} aria-label={t('common.remove')}>
                            ✕
                          </button>
                        )}
                      </DropZone>
                      <div class="row">
                        <select class="input" value={m.agg} onChange={(e) => setMetric(m.id, { agg: e.currentTarget.value as MetricAgg })}>
                          {AGGS.map((a) => (
                            <option value={a.id}>{aggLabel(a.id)}</option>
                          ))}
                        </select>
                        {agg.needsField && (
                          <FieldSelect fields={fields} value={m.field} onChange={(v) => setMetric(m.id, { field: v })} allow={(f) => (m.agg === 'unique' ? true : f.kind === 'number')} />
                        )}
                        {m.agg === 'percentile' && (
                          <input
                            class="input percentile"
                            type="number"
                            min={0}
                            max={100}
                            step="any"
                            title={t('vis.percentile')}
                            aria-label={t('vis.percentile')}
                            value={m.param ?? 90}
                            onInput={(e) => setMetric(m.id, { param: Math.min(100, Math.max(0, Number(e.currentTarget.value) || 0)) })}
                          />
                        )}
                      </div>
                      <input class="input" placeholder={t('vis.customLabel')} value={m.label ?? ''} onInput={(e) => setMetric(m.id, { label: e.currentTarget.value || undefined })} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div class="cfg-section">
            <div class="head">
              {t('vis.breakdown')}
              {vis.breakdown.field && (
                <button class="btn ghost small" onClick={() => setBreakdown({ field: null })}>
                  {t('vis.clear')}
                </button>
              )}
            </div>
            <div class="body">
              <DropZone filled={!!vis.breakdown.field} onDrop={dropG}>
                <span class="lbl">
                  {vis.breakdown.field ? gLabel : t('vis.dropHere')}
                  <span class="sub">{t('vis.topValues')}</span>
                </span>
              </DropZone>
              <FieldSelect fields={fields} value={vis.breakdown.field} onChange={(v) => setBreakdown({ field: v })} />
              {vis.breakdown.field && (
                <div class="row">
                  <FormField label={t('vis.numValues')} class="grow">
                    <input class="input" type="number" min={1} max={50} value={vis.breakdown.size} onInput={(e) => setBreakdown({ size: Number(e.currentTarget.value) || 5 })} />
                  </FormField>
                  <label class="row" style="margin-top:14px">
                    <input type="checkbox" checked={vis.breakdown.other} onChange={(e) => setBreakdown({ other: e.currentTarget.checked })} /> {t('vis.groupOther')}
                  </label>
                </div>
              )}
            </div>
          </div>

          {(vis.chart === 'area' || vis.chart === 'line' || vis.chart === 'bar') && (
            <div class="cfg-section">
              <div class="head">{t('vis.options')}</div>
              <div class="body">
                {vis.chart !== 'line' && (
                  <label class="row">
                    <input type="checkbox" checked={!!vis.percent} onChange={(e) => setVis({ percent: e.currentTarget.checked || undefined })} /> {t('vis.opt.percent')}
                  </label>
                )}
                <label class="row">
                  <input type="checkbox" checked={!!vis.log} onChange={(e) => setVis({ log: e.currentTarget.checked || undefined })} /> {t('vis.opt.log')}
                </label>
                {vis.x.kind === 'date_histogram' && (
                  <label class="row">
                    <input type="checkbox" checked={!!vis.compare} onChange={(e) => setVis({ compare: e.currentTarget.checked || undefined })} /> {t('vis.opt.compare')}
                  </label>
                )}
              </div>
            </div>
          )}

          <div class="cfg-section">
            <div class="head">{t('vis.saved')}</div>
            <div class="body">
              {saved.length === 0 && <div class="hint">{t('vis.nothingSaved')}</div>}
              <div class="saved-list">
                {saved.map((s) => (
                  <div key={s.id} class="item">
                    <span class="t" role="button" tabIndex={0} onClick={() => load(s)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && load(s)} title={formatDate(new Date(s.savedAt))}>
                      {s.title}
                    </span>
                    <button class="btn ghost small danger" onClick={() => del(s.id)} title={t('common.delete')} aria-label={t('common.delete')}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
