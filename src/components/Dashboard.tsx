import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { describeError } from '../errors';
import type { Field } from '../fields';
import { t } from '../i18n';
import { CancelledError } from '../net';
import { compileSearch, fetchVis, type Compiled, type VisResult } from '../queries';
import { autoInterval, bucketOffsetMinutes, intervalByKey, type Interval } from '../sql';
import { loadSavedVis, storeSavedVis, type SavedVis, type SearchState, type VisState } from '../state';
import { Chart } from './Chart';
import { FilterBar } from './FilterBar';
import { QueryBar } from './QueryBar';
import { Popover } from './ui';
import { DataTable, MetricTiles } from './VisTable';
import { breakdownLabel, searchAfterPick, xAxisLabel } from './visutil';

interface TileProps {
  item: SavedVis;
  fields: Field[];
  timeField: Field | null;
  timeExpr: string | null;
  /** the page's search, compiled; the tile adds its own query and filters */
  compiled: Compiled;
  search: SearchState;
  tzOffset: number;
  onSearch: (s: SearchState) => void;
  onOpen: () => void;
  onRemove: () => void;
  onBusy: (b: boolean) => void;
  paused?: boolean;
  refreshTick?: number;
}

function Tile(props: TileProps) {
  const { item, fields, timeExpr, compiled, tzOffset, paused, refreshTick } = props;
  const vis: VisState = item.vis.chart === 'metric' ? { ...item.vis, x: { ...item.vis.x, kind: 'none' } } : item.vis;
  // the tile's own query and filters, over the page's time range
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const own = useMemo(() => compileSearch({ ...item.search, range: props.search.range }, fields, timeExpr), [item.search, props.search.range, fields, timeExpr, refreshTick]);
  const where = `(${compiled.where}) AND (${own.where})`;
  const interval: Interval | null = useMemo(() => {
    if (!compiled.from || !compiled.to) return null;
    return vis.x.interval === 'auto' ? autoInterval(compiled.from, compiled.to, 40) : (intervalByKey(vis.x.interval) ?? autoInterval(compiled.from, compiled.to, 40));
  }, [compiled.from, compiled.to, vis.x.interval]);
  const [result, setResult] = useState<VisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runId = useRef(0);
  const visKey = JSON.stringify(vis);

  useEffect(() => {
    if (compiled.error || own.error || paused) return;
    const id = ++runId.current;
    props.onBusy(true);
    setError(null);
    fetchVis(vis, where, timeExpr, fields, interval, tzOffset)
      .then((r) => {
        if (id === runId.current) setResult(r);
      })
      .catch((e) => {
        if (id === runId.current && !(e instanceof CancelledError)) setError(describeError(e));
      })
      .finally(() => props.onBusy(false));
    // the chart definition is compared by value; refreshTick re-runs an unchanged search on auto refresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [where, compiled.error, own.error, visKey, interval?.key, tzOffset, timeExpr, paused, refreshTick]);

  const chart = vis.chart;
  const err = compiled.error ?? own.error ?? error;
  return (
    <div class="tile">
      <div class="tile-head">
        <b class="tile-title" title={item.search.query || undefined}>
          {item.title}
        </b>
        <span class="grow" />
        <button class="btn ghost small" onClick={props.onOpen} title={t('dash.open')}>
          {t('dash.open')}
        </button>
        <button class="btn ghost small danger" onClick={props.onRemove} title={t('dash.remove')} aria-label={t('dash.remove')}>
          ✕
        </button>
      </div>
      {err && <div class="alert error">{err}</div>}
      {result && chart === 'table' && <DataTable result={result} metrics={vis.metrics} xLabel={xAxisLabel(vis, interval, props.timeField?.name ?? null)} gLabel={breakdownLabel(vis)} />}
      {result && chart === 'metric' && <MetricTiles result={result} metrics={vis.metrics} />}
      {result && (chart === 'area' || chart === 'line' || chart === 'bar') && result.xKind !== 'none' && (
        <Chart
          result={result}
          metrics={vis.metrics}
          chart={chart}
          height={240}
          onBrush={(from, to) => props.onSearch({ ...props.search, range: { from: from.toISOString(), to: to.toISOString() } })}
          onPick={(pick) => {
            const next = searchAfterPick(vis, result.groups, pick, props.search);
            if (next) props.onSearch(next);
          }}
        />
      )}
      {!result && !err && <div class="empty">{t('common.loading')}</div>}
    </div>
  );
}

/** Saved visualizations side by side over one search and time range. */
export function Dashboard(props: {
  fields: Field[];
  timeField: Field | null;
  timeExpr: string | null;
  search: SearchState;
  onSearch: (s: SearchState) => void;
  onOpen: (s: SavedVis) => void;
  onBusy: (b: boolean) => void;
  paused?: boolean;
  refreshTick?: number;
}) {
  const { fields, timeExpr, search, refreshTick } = props;
  const [saved, setSaved] = useState<SavedVis[]>(() => loadSavedVis());
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(0);
  // refreshTick re-resolves `now` in the range on auto refresh
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const compiled = useMemo(() => compileSearch(search, fields, timeExpr), [search, fields, timeExpr, refreshTick]);
  const tzOffset = bucketOffsetMinutes(compiled.to ?? undefined);
  const pinned = saved.filter((s) => s.pinned);
  const others = saved.filter((s) => !s.pinned);

  const setPinned = (id: string, pin: boolean) => {
    const list = saved.map((s) => (s.id === id ? { ...s, pinned: pin } : s));
    setSaved(list);
    storeSavedVis(list);
  };
  const onBusy = (b: boolean) => {
    setRunning((n) => {
      const next = Math.max(0, n + (b ? 1 : -1));
      props.onBusy(next > 0);
      return next;
    });
  };

  return (
    <div class="page">
      <div class="topbar">
        <QueryBar query={search.query} range={search.range} error={compiled.error} busy={running > 0} fields={fields} onSubmit={(query, range) => props.onSearch({ ...search, query, range })} />
        <FilterBar filters={search.filters} fields={fields} onChange={(filters) => props.onSearch({ ...search, filters })} />
      </div>
      {running > 0 && <div class="loading-bar" />}
      <div class="dashboard">
        <div class="row mb8">
          <span class="hint">{t('dash.hint')}</span>
          <span class="grow" />
          <Popover
            open={adding}
            onClose={() => setAdding(false)}
            align="right"
            button={
              <button class="btn small primary" onClick={() => setAdding(!adding)}>
                {t('dash.add')}
              </button>
            }
          >
            <h4>{t('dash.add')}</h4>
            {others.length === 0 && <div class="hint">{saved.length ? t('dash.allAdded') : t('dash.noneSaved')}</div>}
            <div class="menu">
              {others.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setPinned(s.id, true);
                    setAdding(false);
                  }}
                >
                  {s.title}
                </button>
              ))}
            </div>
          </Popover>
        </div>
        {pinned.length === 0 && (
          <div class="empty">
            <h3>{t('dash.empty.title')}</h3>
            <p>{t('dash.empty.text')}</p>
          </div>
        )}
        <div class="dash-grid">
          {pinned.map((s) => (
            <Tile
              key={s.id}
              item={s}
              fields={fields}
              timeField={props.timeField}
              timeExpr={timeExpr}
              compiled={compiled}
              search={search}
              tzOffset={tzOffset}
              onSearch={props.onSearch}
              onOpen={() => props.onOpen(s)}
              onRemove={() => setPinned(s.id, false)}
              onBusy={onBusy}
              paused={props.paused}
              refreshTick={refreshTick}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
