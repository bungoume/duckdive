import { QueryCancelled } from '../duck';
import { formatDate } from '../datefmt';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { TimeRange } from '../datemath';
import type { Field } from '../fields';
import { findField } from '../fields';
import { NULL_GROUP, OTHER, compileSearch, fetchVis, metricLabel, type VisResult } from '../queries';
import { INTERVALS, autoInterval, bucketOffsetMinutes, intervalByKey, intervalLabel, newId, type Filter, type Interval } from '../sql';
import { t, type MsgKey } from '../i18n';
import { useSettings } from '../settings';
import { loadSavedVis, storeSavedVis, type ChartType, type MetricAgg, type MetricDef, type SavedVis, type SearchState, type VisState } from '../state';
import { Chart, type ChartPick } from './Chart';
import { DataTable, MetricTiles } from './VisTable';
import { FieldSidebar } from './FieldSidebar';
import { FilterBar } from './FilterBar';
import { DiagnosePanel } from './DiagnosePanel';
import { QueryBar } from './QueryBar';
import { withCacheHint } from '../diagnose';

const CHARTS: { id: ChartType; icon: string }[] = [
  { id: 'area', icon: '⛰' },
  { id: 'line', icon: '📈' },
  { id: 'bar', icon: '📊' },
  { id: 'table', icon: '▦' },
  { id: 'metric', icon: '🔢' },
];
const chartLabel = (id: ChartType) => t(`vis.chart.${id}` as MsgKey);

const AGGS: { id: MetricAgg; needsField: boolean }[] = [
  { id: 'count', needsField: false },
  { id: 'sum', needsField: true },
  { id: 'avg', needsField: true },
  { id: 'min', needsField: true },
  { id: 'max', needsField: true },
  { id: 'median', needsField: true },
  { id: 'p95', needsField: true },
  { id: 'p99', needsField: true },
  { id: 'unique', needsField: true },
];
const aggLabel = (id: MetricAgg) => t(`vis.agg.${id}` as MsgKey);

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

function FieldSelect(props: { fields: Field[]; value: string | null; onChange: (v: string | null) => void; allow?: (f: Field) => boolean; placeholder?: string }) {
  return (
    <select class="input" value={props.value ?? ''} onChange={(e) => props.onChange((e.target as HTMLSelectElement).value || null)}>
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
}) {
  const { fields, timeExpr, search, vis } = props;
  const compiled = useMemo(() => compileSearch(search, fields, timeExpr), [search, fields, timeExpr]);
  const effVis: VisState = vis.chart === 'metric' ? { ...vis, x: { ...vis.x, kind: 'none' } } : vis;
  const interval: Interval | null = useMemo(() => {
    if (!compiled.from || !compiled.to) return null;
    return vis.x.interval === 'auto' ? autoInterval(compiled.from, compiled.to, 50) : (intervalByKey(vis.x.interval) ?? autoInterval(compiled.from, compiled.to, 50));
  }, [compiled, vis.x.interval]);

  // buckets are aligned with the display time zone: re-query when it changes
  const settings = useSettings();
  const tzOffset = useMemo(() => bucketOffsetMinutes(compiled.to ?? undefined), [compiled, settings.timeZone]);

  const [result, setResult] = useState<VisResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [saved, setSaved] = useState<SavedVis[]>(() => loadSavedVis());
  const runId = useRef(0);
  const visKey = JSON.stringify(effVis);

  useEffect(() => {
    if (compiled.error || props.paused) return;
    const id = ++runId.current;
    setBusy(true);
    props.onBusy(true);
    setError(null);
    fetchVis(effVis, compiled.where, timeExpr, fields, interval, tzOffset)
      .then((r) => {
        if (id === runId.current) setResult(r);
      })
      .catch((e) => {
        if (id === runId.current && !(e instanceof QueryCancelled)) setError(withCacheHint(String(e)));
      })
      .finally(() => {
        if (id === runId.current) {
          setBusy(false);
          props.onBusy(false);
        }
      });
  }, [compiled.where, compiled.error, visKey, interval?.key, tzOffset, timeExpr, props.paused]);

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
    const groups = result?.groups ?? [];
    if (vis.breakdown.field && groups.length) {
      if (pick.series === OTHER) {
        const top = groups.filter((g) => g !== OTHER);
        if (top.length) props.onSearch({ ...search, filters: [...search.filters, { id: newId(), field: vis.breakdown.field, op: 'is_not_one_of', values: top }] });
        return;
      }
      addFilter(vis.breakdown.field, pick.series === NULL_GROUP ? null : pick.series, false);
      return;
    }
    if (vis.x.kind === 'terms' && vis.x.field) {
      addFilter(vis.x.field, pick.x === NULL_GROUP ? null : String(pick.x), false);
      return;
    }
    if (pick.isTime && pick.x instanceof Date && pick.intervalMs) onBrush(pick.x, new Date(pick.x.getTime() + pick.intervalMs));
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

  const xLabel =
    vis.x.kind === 'date_histogram'
      ? t('vis.xLabel.date', { field: vis.x.field ?? props.timeField?.name ?? t('vis.time'), interval: interval ? intervalLabel(interval).toLowerCase() : '' })
      : vis.x.kind === 'terms'
        ? t('vis.xLabel.terms', { n: vis.x.size, field: vis.x.field ?? '?' })
        : vis.x.kind === 'histogram'
          ? t('vis.xLabel.hist', { field: vis.x.field ?? '?', size: vis.x.interval })
          : '';
  const gLabel = vis.breakdown.field ? t('vis.xLabel.terms', { n: vis.breakdown.size, field: vis.breakdown.field }) : null;

  return (
    <div class="page">
      <div class="topbar">
        <QueryBar query={search.query} range={search.range} error={compiled.error ?? error} busy={busy} onSubmit={submit} />
        <DiagnosePanel error={error} />
        <FilterBar filters={search.filters} fields={fields} onChange={(filters) => props.onSearch({ ...search, filters })} />
      </div>
      {busy && <div class="loading-bar" />}
      <div class="visualize">
        <FieldSidebar fields={fields} selected={[]} where={compiled.where} mode="visualize" onAddFilter={addFilter} />
        <div class="center">
          <div class="canvas">
            <div class="vis-panel">
              <div class="row" style="margin-bottom:8px">
                <input class="input" style="font-weight:600;flex:1" placeholder={t('vis.untitled')} value={vis.title} onInput={(e) => setVis({ title: (e.target as HTMLInputElement).value })} />
                <button class="btn small" onClick={() => setShowSql(!showSql)}>
                  {showSql ? t('vis.hideSql') : t('vis.showSql')}
                </button>
                <button class="btn primary small" onClick={save}>
                  {t('common.save')}
                </button>
              </div>
              {showSql && result && (
                <div class="sql-box" style="margin-bottom:8px">
                  {result.sql}
                </div>
              )}
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
                    <Chart result={result} metrics={vis.metrics} chart={vis.chart} onBrush={onBrush} onPick={onPick} height={380} />
                  )}
                  {result.groups.length > 0 && vis.metrics.length > 1 && <div class="legend-note">{t('vis.breakdownNote')}</div>}
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
                  <button class={vis.chart === c.id ? 'active' : ''} onClick={() => setVis({ chart: c.id })} title={chartLabel(c.id)}>
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
                    <span class="sub">{vis.x.kind === 'none' ? t('vis.orPickBelow') : t(`vis.sub.${vis.x.kind}` as MsgKey)}</span>
                  </span>
                </DropZone>
                <div class="field-row">
                  <label>{t('vis.function')}</label>
                  <select class="input" value={vis.x.kind} onChange={(e) => setX({ kind: (e.target as HTMLSelectElement).value as VisState['x']['kind'] })}>
                    <option value="none">–</option>
                    <option value="date_histogram">{t('vis.fn.dateHistogram')}</option>
                    <option value="terms">{t('vis.fn.terms')}</option>
                    <option value="histogram">{t('vis.fn.histogram')}</option>
                  </select>
                </div>
                {vis.x.kind === 'date_histogram' && (
                  <>
                    <div class="field-row">
                      <label>{t('common.field')}</label>
                      <FieldSelect
                        fields={fields}
                        value={vis.x.field}
                        onChange={(v) => setX({ field: v })}
                        allow={(f) => f.kind === 'date'}
                        placeholder={t('vis.timeFieldPlaceholder', { name: props.timeField?.name ?? t('common.none') })}
                      />
                    </div>
                    <div class="field-row">
                      <label>{t('vis.minInterval')}</label>
                      <select class="input" value={vis.x.interval} onChange={(e) => setX({ interval: (e.target as HTMLSelectElement).value })}>
                        <option value="auto">{t('common.auto')}</option>
                        {INTERVALS.map((iv) => (
                          <option value={iv.key}>{intervalLabel(iv)}</option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
                {vis.x.kind === 'terms' && (
                  <>
                    <div class="field-row">
                      <label>{t('common.field')}</label>
                      <FieldSelect fields={fields} value={vis.x.field} onChange={(v) => setX({ field: v })} />
                    </div>
                    <div class="row">
                      <div class="field-row" style="flex:1">
                        <label>{t('vis.numValues')}</label>
                        <input class="input" type="number" min={1} max={500} value={vis.x.size} onInput={(e) => setX({ size: Number((e.target as HTMLInputElement).value) || 10 })} />
                      </div>
                      <div class="field-row" style="flex:1">
                        <label>{t('vis.rankBy')}</label>
                        <select class="input" value={vis.x.orderBy} onChange={(e) => setX({ orderBy: (e.target as HTMLSelectElement).value as 'metric' | 'alpha' })}>
                          <option value="metric">{metricLabel(vis.metrics[0])}</option>
                          <option value="alpha">{t('vis.alphabetical')}</option>
                        </select>
                      </div>
                      <div class="field-row" style="width:90px">
                        <label>{t('vis.direction')}</label>
                        <select class="input" value={vis.x.orderDir} onChange={(e) => setX({ orderDir: (e.target as HTMLSelectElement).value as 'asc' | 'desc' })}>
                          <option value="desc">{t('vis.desc')}</option>
                          <option value="asc">{t('vis.asc')}</option>
                        </select>
                      </div>
                    </div>
                  </>
                )}
                {vis.x.kind === 'histogram' && (
                  <>
                    <div class="field-row">
                      <label>{t('common.field')}</label>
                      <FieldSelect fields={fields} value={vis.x.field} onChange={(v) => setX({ field: v })} allow={(f) => f.kind === 'number'} />
                    </div>
                    <div class="field-row">
                      <label>{t('vis.bucketSize')}</label>
                      <input
                        class="input"
                        type="number"
                        min={0}
                        step="any"
                        value={vis.x.interval === 'auto' ? 10 : vis.x.interval}
                        onInput={(e) => setX({ interval: (e.target as HTMLInputElement).value })}
                      />
                    </div>
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
                  <div class="cfg-section" style="border-style:dashed">
                    <div class="body">
                      <DropZone filled={true} onDrop={(name) => dropY(name, m.id)}>
                        <span class="lbl">
                          {metricLabel(m)}
                          <span class="sub">{t('vis.dropToChange')}</span>
                        </span>
                        {vis.metrics.length > 1 && (
                          <button class="x" onClick={() => removeMetric(m.id)} title={t('common.remove')}>
                            ✕
                          </button>
                        )}
                      </DropZone>
                      <div class="row">
                        <select class="input" value={m.agg} onChange={(e) => setMetric(m.id, { agg: (e.target as HTMLSelectElement).value as MetricAgg })}>
                          {AGGS.map((a) => (
                            <option value={a.id}>{aggLabel(a.id)}</option>
                          ))}
                        </select>
                        {agg.needsField && (
                          <FieldSelect fields={fields} value={m.field} onChange={(v) => setMetric(m.id, { field: v })} allow={(f) => (m.agg === 'unique' ? true : f.kind === 'number')} />
                        )}
                      </div>
                      <input class="input" placeholder={t('vis.customLabel')} value={m.label ?? ''} onInput={(e) => setMetric(m.id, { label: (e.target as HTMLInputElement).value || undefined })} />
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
                  <div class="field-row" style="flex:1">
                    <label>{t('vis.numValues')}</label>
                    <input class="input" type="number" min={1} max={50} value={vis.breakdown.size} onInput={(e) => setBreakdown({ size: Number((e.target as HTMLInputElement).value) || 5 })} />
                  </div>
                  <label class="row" style="margin-top:14px">
                    <input type="checkbox" checked={vis.breakdown.other} onChange={(e) => setBreakdown({ other: (e.target as HTMLInputElement).checked })} /> {t('vis.groupOther')}
                  </label>
                </div>
              )}
            </div>
          </div>

          <div class="cfg-section">
            <div class="head">{t('vis.saved')}</div>
            <div class="body">
              {saved.length === 0 && <div class="hint">{t('vis.nothingSaved')}</div>}
              <div class="saved-list">
                {saved.map((s) => (
                  <div class="item">
                    <span class="t" onClick={() => load(s)} title={formatDate(new Date(s.savedAt))}>
                      {s.title}
                    </span>
                    <button class="btn ghost small danger" onClick={() => del(s.id)} title={t('common.delete')}>
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
