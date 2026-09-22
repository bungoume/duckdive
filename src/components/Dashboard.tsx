import type { TimeContext } from '../datemath';
import { useMemo, useState } from 'preact/hooks';
import type { Field } from '../fields';
import { t } from '../i18n';
import { compileSearch, type Compiled } from '../queries';
import { useVisQuery } from '../hooks/useVisQuery';
import { loadSavedVis, storeSavedVis } from '../savedViews';
import { type SavedVis, type SearchState } from '../state';
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
  onSearch: (s: SearchState) => void;
  onOpen: () => void;
  onRemove: () => void;
  onBusy: (b: boolean) => void;
  paused?: boolean;
  refreshTick?: number;
}

function Tile(props: TileProps) {
  const { item, fields, timeExpr, compiled, paused, refreshTick } = props;
  const vis = item.vis;
  // the tile's own query and filters, over the page's time range
  const own = useMemo(() => compileSearch({ ...item.search, range: props.search.range }, fields, timeExpr, compiled.context), [item.search, props.search.range, fields, timeExpr, compiled.context]);
  const { result, previous, error, interval, compare } = useVisQuery({
    vis,
    compiled: { ...compiled, where: `(${compiled.where}) AND (${own.where})`, error: compiled.error ?? own.error },
    searches: [props.search, item.search],
    fields,
    timeExpr,
    targetBuckets: 40,
    onBusy: props.onBusy,
    paused,
    refreshTick,
  });

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
      {result && chart === 'table' && <DataTable result={result} metrics={vis.metrics} xLabel={xAxisLabel(vis, interval, props.timeField?.name ?? null, result.step)} gLabel={breakdownLabel(vis)} />}
      {result && chart === 'metric' && <MetricTiles result={result} metrics={vis.metrics} />}
      {result && (chart === 'area' || chart === 'line' || chart === 'bar') && result.xKind !== 'none' && (
        <Chart
          result={result}
          metrics={vis.metrics}
          chart={chart}
          height={240}
          percent={vis.percent}
          log={vis.log}
          compare={compare ? previous : null}
          onBrush={(from, to) => props.onSearch({ ...props.search, range: { from: from.toISOString(), to: to.toISOString() } })}
          onPick={(pick) => {
            const next = searchAfterPick(vis, result.groups, pick, props.search);
            if (next) props.onSearch(next);
          }}
        />
      )}
      {compare && previous && <div class="legend-note">{t('vis.previousNote')}</div>}
      {!result && !err && <div class="empty">{t('common.loading')}</div>}
    </div>
  );
}

/** Saved visualizations side by side over one search and time range. */
export function Dashboard(props: {
  evaluation: TimeContext;
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
  const compiled = useMemo(() => compileSearch(search, fields, timeExpr, props.evaluation), [search, fields, timeExpr, props.evaluation]);
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
