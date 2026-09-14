import { QueryCancelled } from '../duck';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { TimeRange } from '../datemath';
import type { Field } from '../fields';
import { findField } from '../fields';
import { OTHER, compileSearch, fetchVis, metricLabel, type VisResult } from '../queries';
import { INTERVALS, autoInterval, intervalByKey, newId, type Filter, type Interval } from '../sql';
import { loadSavedVis, storeSavedVis, type ChartType, type MetricAgg, type MetricDef, type SavedVis, type SearchState, type VisState } from '../state';
import { Chart, DataTable, MetricTiles, type ChartPick } from './Chart';
import { FieldSidebar } from './FieldSidebar';
import { FilterBar } from './FilterBar';
import { DiagnosePanel } from './DiagnosePanel';
import { QueryBar } from './QueryBar';

const CHARTS: { id: ChartType; label: string; icon: string }[] = [
  { id: 'area', label: 'Area', icon: '⛰' },
  { id: 'line', label: 'Line', icon: '📈' },
  { id: 'bar', label: 'Bar', icon: '📊' },
  { id: 'table', label: 'Table', icon: '▦' },
  { id: 'metric', label: 'Metric', icon: '🔢' },
];

const AGGS: { id: MetricAgg; label: string; needsField: boolean }[] = [
  { id: 'count', label: 'Count', needsField: false },
  { id: 'sum', label: 'Sum', needsField: true },
  { id: 'avg', label: 'Average', needsField: true },
  { id: 'min', label: 'Minimum', needsField: true },
  { id: 'max', label: 'Maximum', needsField: true },
  { id: 'median', label: 'Median', needsField: true },
  { id: 'p95', label: '95th percentile', needsField: true },
  { id: 'p99', label: '99th percentile', needsField: true },
  { id: 'unique', label: 'Unique count', needsField: true },
];

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
      <option value="">{props.placeholder ?? 'Select a field'}</option>
      {props.fields.filter((f) => f.kind !== 'object' && (!props.allow || props.allow(f))).map((f) => (
        <option value={f.name}>{f.name}</option>
      ))}
    </select>
  );
}

/** Errors that smell like damaged file bytes get a pointer to the cache controls. */
function withCacheHint(msg: string): string {
  return /gzip|zstd|magic|corrupt|Parquet file|invalid/i.test(msg)
    ? `${msg}\n\nUse "Find the failing file" below to locate and inspect the file DuckDB rejects. If the cache is suspected: Data source → Local range cache → "Clear cache" or untick "Enable range cache".`
    : msg;
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
    fetchVis(effVis, compiled.where, timeExpr, fields, interval)
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
  }, [compiled.where, compiled.error, visKey, interval?.key, timeExpr, props.paused]);

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
      addFilter(vis.breakdown.field, pick.series === '(null)' ? null : pick.series, false);
      return;
    }
    if (vis.x.kind === 'terms' && vis.x.field) {
      addFilter(vis.x.field, pick.x === '(null)' ? null : String(pick.x), false);
      return;
    }
    if (pick.isTime && pick.x instanceof Date && pick.intervalMs) onBrush(pick.x, new Date(pick.x.getTime() + pick.intervalMs));
  };

  const save = () => {
    const title = vis.title.trim() || `Visualization ${saved.length + 1}`;
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
      ? `${vis.x.field ?? props.timeField?.name ?? 'time'} per ${interval?.label.toLowerCase() ?? ''}`
      : vis.x.kind === 'terms'
        ? `Top ${vis.x.size} values of ${vis.x.field ?? '?'}`
        : vis.x.kind === 'histogram'
          ? `${vis.x.field ?? '?'} (bucket ${vis.x.interval})`
          : '';
  const gLabel = vis.breakdown.field ? `Top ${vis.breakdown.size} values of ${vis.breakdown.field}` : null;

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
                <input class="input" style="font-weight:600;flex:1" placeholder="Untitled visualization" value={vis.title} onInput={(e) => setVis({ title: (e.target as HTMLInputElement).value })} />
                <button class="btn small" onClick={() => setShowSql(!showSql)}>
                  {showSql ? 'Hide SQL' : 'Show SQL'}
                </button>
                <button class="btn primary small" onClick={save}>
                  Save
                </button>
              </div>
              {showSql && result && <div class="sql-box" style="margin-bottom:8px">{result.sql}</div>}
              {result && vis.chart === 'table' && <DataTable result={result} metrics={vis.metrics} xLabel={xLabel} gLabel={gLabel} />}
              {result && vis.chart === 'metric' && <MetricTiles result={result} metrics={vis.metrics} />}
              {result && (vis.chart === 'area' || vis.chart === 'line' || vis.chart === 'bar') && (
                <>
                  {result.xKind === 'none' ? (
                    <div class="empty">
                      <h3>Choose a horizontal axis</h3>
                      <p>Drag a field onto "Horizontal axis" or pick one in the panel on the right.</p>
                    </div>
                  ) : (
                    <Chart result={result} metrics={vis.metrics} chart={vis.chart} onBrush={onBrush} onPick={onPick} height={380} />
                  )}
                  {result.groups.length > 0 && vis.metrics.length > 1 && <div class="legend-note">With a breakdown, the chart shows the first metric only. Switch to Table to see all metrics.</div>}
                </>
              )}
              {!result && !error && <div class="empty">Loading…</div>}
            </div>
          </div>
        </div>
        <div class="config">
          <div class="cfg-section">
            <div class="head">Visualization type</div>
            <div class="body">
              <div class="chart-types">
                {CHARTS.map((c) => (
                  <button class={vis.chart === c.id ? 'active' : ''} onClick={() => setVis({ chart: c.id })} title={c.label}>
                    <span class="ic">{c.icon}</span>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {vis.chart !== 'metric' && (
            <div class="cfg-section">
              <div class="head">
                Horizontal axis
                {vis.x.kind !== 'none' && (
                  <button class="btn ghost small" onClick={() => setX({ kind: 'none', field: null })}>
                    clear
                  </button>
                )}
              </div>
              <div class="body">
                <DropZone filled={vis.x.kind !== 'none'} onDrop={dropX}>
                  <span class="lbl">
                    {vis.x.kind === 'none' ? 'Drop a field here' : xLabel}
                    <span class="sub">{vis.x.kind === 'none' ? 'or pick one below' : vis.x.kind.replace('_', ' ')}</span>
                  </span>
                </DropZone>
                <div class="field-row">
                  <label>Function</label>
                  <select class="input" value={vis.x.kind} onChange={(e) => setX({ kind: (e.target as HTMLSelectElement).value as VisState['x']['kind'] })}>
                    <option value="none">–</option>
                    <option value="date_histogram">Date histogram</option>
                    <option value="terms">Top values</option>
                    <option value="histogram">Intervals (numeric histogram)</option>
                  </select>
                </div>
                {vis.x.kind === 'date_histogram' && (
                  <>
                    <div class="field-row">
                      <label>Field</label>
                      <FieldSelect fields={fields} value={vis.x.field} onChange={(v) => setX({ field: v })} allow={(f) => f.kind === 'date'} placeholder={`(time field: ${props.timeField?.name ?? 'none'})`} />
                    </div>
                    <div class="field-row">
                      <label>Minimum interval</label>
                      <select class="input" value={vis.x.interval} onChange={(e) => setX({ interval: (e.target as HTMLSelectElement).value })}>
                        <option value="auto">Auto</option>
                        {INTERVALS.map((iv) => (
                          <option value={iv.key}>{iv.label}</option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
                {vis.x.kind === 'terms' && (
                  <>
                    <div class="field-row">
                      <label>Field</label>
                      <FieldSelect fields={fields} value={vis.x.field} onChange={(v) => setX({ field: v })} />
                    </div>
                    <div class="row">
                      <div class="field-row" style="flex:1">
                        <label>Number of values</label>
                        <input class="input" type="number" min={1} max={500} value={vis.x.size} onInput={(e) => setX({ size: Number((e.target as HTMLInputElement).value) || 10 })} />
                      </div>
                      <div class="field-row" style="flex:1">
                        <label>Rank by</label>
                        <select class="input" value={vis.x.orderBy} onChange={(e) => setX({ orderBy: (e.target as HTMLSelectElement).value as 'metric' | 'alpha' })}>
                          <option value="metric">{metricLabel(vis.metrics[0])}</option>
                          <option value="alpha">Alphabetical</option>
                        </select>
                      </div>
                      <div class="field-row" style="width:90px">
                        <label>Direction</label>
                        <select class="input" value={vis.x.orderDir} onChange={(e) => setX({ orderDir: (e.target as HTMLSelectElement).value as 'asc' | 'desc' })}>
                          <option value="desc">Desc</option>
                          <option value="asc">Asc</option>
                        </select>
                      </div>
                    </div>
                  </>
                )}
                {vis.x.kind === 'histogram' && (
                  <>
                    <div class="field-row">
                      <label>Field</label>
                      <FieldSelect fields={fields} value={vis.x.field} onChange={(v) => setX({ field: v })} allow={(f) => f.kind === 'number'} />
                    </div>
                    <div class="field-row">
                      <label>Bucket size</label>
                      <input class="input" type="number" min={0} step="any" value={vis.x.interval === 'auto' ? 10 : vis.x.interval} onInput={(e) => setX({ interval: (e.target as HTMLInputElement).value })} />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          <div class="cfg-section">
            <div class="head">
              {vis.chart === 'metric' ? 'Metrics' : 'Vertical axis'}
              <button class="btn ghost small" onClick={() => addMetric()}>
                + Add
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
                          <span class="sub">drop a field to change</span>
                        </span>
                        {vis.metrics.length > 1 && (
                          <button class="x" onClick={() => removeMetric(m.id)} title="Remove">
                            ✕
                          </button>
                        )}
                      </DropZone>
                      <div class="row">
                        <select class="input" value={m.agg} onChange={(e) => setMetric(m.id, { agg: (e.target as HTMLSelectElement).value as MetricAgg })}>
                          {AGGS.map((a) => (
                            <option value={a.id}>{a.label}</option>
                          ))}
                        </select>
                        {agg.needsField && (
                          <FieldSelect fields={fields} value={m.field} onChange={(v) => setMetric(m.id, { field: v })} allow={(f) => (m.agg === 'unique' ? true : f.kind === 'number')} />
                        )}
                      </div>
                      <input class="input" placeholder="Custom label" value={m.label ?? ''} onInput={(e) => setMetric(m.id, { label: (e.target as HTMLInputElement).value || undefined })} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div class="cfg-section">
            <div class="head">
              Break down by
              {vis.breakdown.field && (
                <button class="btn ghost small" onClick={() => setBreakdown({ field: null })}>
                  clear
                </button>
              )}
            </div>
            <div class="body">
              <DropZone filled={!!vis.breakdown.field} onDrop={dropG}>
                <span class="lbl">
                  {vis.breakdown.field ? gLabel : 'Drop a field here'}
                  <span class="sub">top values</span>
                </span>
              </DropZone>
              <FieldSelect fields={fields} value={vis.breakdown.field} onChange={(v) => setBreakdown({ field: v })} />
              {vis.breakdown.field && (
                <div class="row">
                  <div class="field-row" style="flex:1">
                    <label>Number of values</label>
                    <input class="input" type="number" min={1} max={50} value={vis.breakdown.size} onInput={(e) => setBreakdown({ size: Number((e.target as HTMLInputElement).value) || 5 })} />
                  </div>
                  <label class="row" style="margin-top:14px">
                    <input type="checkbox" checked={vis.breakdown.other} onChange={(e) => setBreakdown({ other: (e.target as HTMLInputElement).checked })} /> Group remaining as "Other"
                  </label>
                </div>
              )}
            </div>
          </div>

          <div class="cfg-section">
            <div class="head">Saved visualizations</div>
            <div class="body">
              {saved.length === 0 && <div class="hint">Nothing saved yet. Saved items live in this browser (localStorage).</div>}
              <div class="saved-list">
                {saved.map((s) => (
                  <div class="item">
                    <span class="t" onClick={() => load(s)} title={new Date(s.savedAt).toLocaleString()}>
                      {s.title}
                    </span>
                    <button class="btn ghost small danger" onClick={() => del(s.id)} title="Delete">
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
