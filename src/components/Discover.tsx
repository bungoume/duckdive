import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { TimeRange } from '../datemath';
import { formatLocal } from '../datemath';
import type { Field } from '../fields';
import { findField } from '../fields';
import { compileSearch, fetchCount, fetchDocs, fetchHistogram, type Bucket, type Doc } from '../queries';
import { INTERVALS, autoInterval, bucketOffsetMinutes, intervalByKey, intervalLabel, newId, type Filter, type Interval } from '../sql';
import { t } from '../i18n';
import { useSettings } from '../settings';
import type { DiscoverState, SearchState } from '../state';
import { DocTable } from './DocTable';
import { FieldSidebar } from './FieldSidebar';
import { FilterBar } from './FilterBar';
import { Histogram, fillBuckets } from './Histogram';
import { DiagnosePanel } from './DiagnosePanel';
import { QueryBar } from './QueryBar';
import { withCacheHint } from '../diagnose';
import { QueryCancelled } from '../duck';

const PAGE = 100;

export function Discover(props: {
  fields: Field[];
  timeField: Field | null;
  timeExpr: string | null;
  search: SearchState;
  discover: DiscoverState;
  onSearch: (s: SearchState) => void;
  onDiscover: (d: DiscoverState) => void;
  onVisualizeField: (f: Field) => void;
  onBusy: (b: boolean) => void;
  /** true while the file list is being re-resolved: skip queries against the stale view */
  paused?: boolean;
}) {
  const { fields, timeExpr, search, discover } = props;
  const compiled = useMemo(() => compileSearch(search, fields, timeExpr), [search, fields, timeExpr]);
  const interval: Interval | null = useMemo(() => {
    if (!compiled.from || !compiled.to) return null;
    return discover.interval === 'auto' ? autoInterval(compiled.from, compiled.to) : (intervalByKey(discover.interval) ?? autoInterval(compiled.from, compiled.to));
  }, [compiled, discover.interval]);

  // buckets are aligned with the display time zone: re-query when it changes
  const settings = useSettings();
  const tzOffset = useMemo(() => bucketOffsetMinutes(compiled.to ?? undefined), [compiled, settings.timeZone]);

  const [count, setCount] = useState<number | null>(null);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  /** the statement behind the document table (what "show SQL" displays) */
  const [docsSql, setDocsSql] = useState('');
  // bumped for every fresh result (not for "load more"): the table's expanded rows are reset with it
  const [resultSeq, setResultSeq] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [showSql, setShowSql] = useState(false);
  const runId = useRef(0);

  const sortKey = JSON.stringify(discover.sort);
  const colKey = JSON.stringify(discover.columns);

  useEffect(() => {
    if (compiled.error || props.paused) return;
    const id = ++runId.current;
    setBusy(true);
    props.onBusy(true);
    setError(null);
    const t0 = performance.now();
    (async () => {
      try {
        // With a time field the histogram already counts every matching row (the range condition
        // excludes NULL times), so the separate count(*) scan is only needed without one.
        const withHistogram = !!(timeExpr && interval);
        const [n, b, d] = await Promise.all([
          withHistogram ? Promise.resolve(null) : fetchCount(compiled.where),
          withHistogram ? fetchHistogram(compiled.where, timeExpr!, interval!, tzOffset) : Promise.resolve([]),
          fetchDocs(compiled.where, timeExpr, fields, discover.sort, discover.columns, PAGE, 0),
        ]);
        if (id !== runId.current) return;
        setCount(n ?? b.reduce((a, x) => a + x.c, 0));
        setBuckets(b);
        setDocs(d.docs);
        setDocsSql(d.sql);
        setResultSeq((s) => s + 1);
        setElapsed(performance.now() - t0);
      } catch (e) {
        if (id === runId.current && !(e instanceof QueryCancelled)) setError(withCacheHint(String(e)));
      } finally {
        if (id === runId.current) {
          setBusy(false);
          props.onBusy(false);
        }
      }
    })();
  }, [compiled.where, compiled.error, interval?.key, tzOffset, sortKey, colKey, timeExpr, props.paused]);

  const loadMore = async () => {
    setBusy(true);
    props.onBusy(true);
    try {
      const more = await fetchDocs(compiled.where, timeExpr, fields, discover.sort, discover.columns, PAGE, docs.length);
      setDocs([...docs, ...more.docs]);
    } catch (e) {
      if (!(e instanceof QueryCancelled)) setError(withCacheHint(String(e)));
    } finally {
      setBusy(false);
      props.onBusy(false);
    }
  };

  const setFilters = (filters: Filter[]) => props.onSearch({ ...search, filters });
  const addFilter = (field: string, value: string | null, negate: boolean) => {
    const f = findField(fields, field);
    if (!f) return;
    const fl: Filter = value === null ? { id: newId(), field: f.name, op: 'does_not_exist', negate } : { id: newId(), field: f.name, op: 'is', value, negate };
    setFilters([...search.filters, fl]);
  };
  const addExists = (field: string) => {
    const f = findField(fields, field);
    if (f) setFilters([...search.filters, { id: newId(), field: f.name, op: 'exists' }]);
  };
  const toggleColumn = (name: string) => {
    const cols = discover.columns.includes(name) ? discover.columns.filter((c) => c !== name) : [...discover.columns, name];
    props.onDiscover({ ...discover, columns: cols });
  };
  const onSort = (field: string) => {
    const cur = discover.sort.find((s) => s.field === field);
    const dir = cur ? (cur.dir === 'desc' ? 'asc' : 'desc') : 'desc';
    props.onDiscover({ ...discover, sort: [{ field, dir }] });
  };
  const onBrush = (from: Date, to: Date) => props.onSearch({ ...search, range: { from: from.toISOString(), to: to.toISOString() } });
  const submit = (query: string, range: TimeRange) => props.onSearch({ ...search, query, range });

  const filled = useMemo(() => (interval && compiled.from && compiled.to ? fillBuckets(buckets, compiled.to, interval, tzOffset) : buckets), [buckets, interval, compiled, tzOffset]);

  return (
    <div class="page">
      <div class="topbar">
        <QueryBar query={search.query} range={search.range} error={compiled.error ?? error} busy={busy} onSubmit={submit} />
        <DiagnosePanel error={error} />
        <FilterBar filters={search.filters} fields={fields} onChange={setFilters} />
      </div>
      {busy && <div class="loading-bar" />}
      <div class="discover">
        <FieldSidebar fields={fields} selected={discover.columns} where={compiled.where} mode="discover" onToggleColumn={toggleColumn} onAddFilter={addFilter} onVisualize={props.onVisualizeField} />
        <div class="main">
          <div class="hits">
            <span class="n">{count === null ? '…' : count.toLocaleString()}</span>
            <span>{t('disc.hits')}</span>
            <span class="meta">
              {elapsed ? `${Math.round(elapsed)} ms` : ''}
              {compiled.from && compiled.to ? ` · ${formatLocal(compiled.from)} → ${formatLocal(compiled.to)}` : ''}
            </span>
            <span style="flex:1" />
            <button class="sql-toggle" onClick={() => setShowSql(!showSql)}>
              {showSql ? t('disc.hideSql') : t('disc.showSql')}
            </button>
          </div>
          {showSql && (
            <div style="padding:0 16px">
              <div class="sql-box">{docsSql}</div>
            </div>
          )}
          {timeExpr && interval && compiled.from && compiled.to && (
            <div class="chart-panel">
              <div class="chart-head">
                <span>{t('disc.perInterval', { field: props.timeField?.name ?? '', interval: intervalLabel(interval).toLowerCase() })}</span>
                <select
                  class="input"
                  style="width:auto;padding:2px 6px;font-size:12px"
                  value={discover.interval}
                  onChange={(e) => props.onDiscover({ ...discover, interval: (e.target as HTMLSelectElement).value })}
                >
                  <option value="auto">{t('common.auto')}</option>
                  {INTERVALS.map((iv) => (
                    <option value={iv.key}>{intervalLabel(iv)}</option>
                  ))}
                </select>
              </div>
              <Histogram buckets={filled} interval={interval} tzOffset={tzOffset} from={compiled.from} to={compiled.to} onBrush={onBrush} />
            </div>
          )}
          <div class="doc-wrap">
            {docs.length === 0 && !busy ? (
              <div class="empty">
                <h3>{t('disc.empty.title')}</h3>
                <p>{t('disc.empty.text')}</p>
              </div>
            ) : (
              <>
                <DocTable
                  key={resultSeq}
                  docs={docs}
                  fields={fields}
                  columns={discover.columns}
                  hasTime={!!timeExpr}
                  timeFieldName={props.timeField?.name ?? null}
                  sort={discover.sort}
                  onSort={onSort}
                  onRemoveColumn={toggleColumn}
                  onToggleColumn={toggleColumn}
                  onFilter={addFilter}
                  onExists={addExists}
                />
                {count !== null && docs.length < count && (
                  <div class="load-more">
                    <button class="btn" onClick={loadMore} disabled={busy}>
                      {t('disc.loadMore', { shown: docs.length.toLocaleString(), total: count.toLocaleString() })}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
