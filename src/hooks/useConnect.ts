import { analysisTemplateFor } from '../analysisTemplates';
import { timeContext, type TimeContext } from '../datemath';
import { useEffect, useRef, useState, type Dispatch, type StateUpdater } from 'preact/hooks';
import { isUsable, loadCredentials } from '../auth';
import type { TimeWindow } from '../datasource';
import { fileWindow, needsComparison } from '../comparison';
import { createConnection, valueFiltersFor } from '../connection';
import { expose } from '../debug';
import { describeError } from '../errors';
import { DataProtocol, cancelAllQueries, getDB, getQueryLog, initDuckDB, queriesRunning, query } from '../duck';
import { findField } from '../fields';
import { NO_LOCAL, type LocalSelection } from '../localfiles';
import { withSecrets } from '../secrets';
import { loadSource, sourceForKnownLink, sourceKey, type SourceConfig } from '../sources';
import { loadSavedVis, savedVisRevision } from '../savedViews';
import { type UrlState } from '../state';
import { useStore } from '../store';

/** What a file resolution depends on: the time range and the captured-column filters of `cfg`, and the auto-refresh tick (new files may have arrived). */
function rangeKeyFor(
  cfg: SourceConfig,
  url: UrlState,
  tick: number,
  compare: boolean,
  evaluation: TimeContext,
): string {
  return JSON.stringify([
    url.search.range,
    fileWindow(url.search.range, compare, evaluation),
    valueFiltersFor(cfg, url),
    tick,
  ]);
}

export function useConnect(
  url: UrlState,
  setUrl: Dispatch<StateUpdater<UrlState>>,
  queryBusy: { current: boolean },
  linkSource: SourceConfig | null = null,
  refreshTick = 0,
  evaluation = timeContext(),
) {
  useStore(savedVisRevision);
  const compare = needsComparison(url, loadSavedVis());
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [connection] = useState(() =>
    createConnection(
      loadSource(),
      () => setUrl((u) => ({ ...u, page: 'source' })),
      () => queryBusy.current,
    ),
  );
  const state = useStore(connection);
  const { source, pendingSource, history, switchSeq, attached, phase, variables, creds } = state;
  const attaching = phase.status === 'connecting' || phase.status === 'confirming';
  const attachProgress = attaching ? phase.progress : null;
  const attachError = phase.status === 'failed' ? phase.error : null;
  const largeConfirm = phase.status === 'confirming' ? phase.confirmation : null;
  const { setCreds, ackedFiles, forget, onTimeField } = connection;
  const attemptedKey = useRef('');
  const currentWindow = () => fileWindow(url.search.range, compare, evaluation);
  const request = (cfg: SourceConfig, local: LocalSelection, interactive: boolean, window: TimeWindow | null) => ({
    local,
    interactive,
    window,
    valueFilters: valueFiltersFor(cfg, url),
  });
  const connect = async (
    cfg: SourceConfig,
    local: LocalSelection = NO_LOCAL,
    interactive = true,
    window: TimeWindow | null = currentWindow(),
  ) => {
    attemptedKey.current = rangeKeyFor(cfg, url, refreshTick, compare, evaluation);
    const pending = connection.connect(cfg, request(cfg, local, interactive, window));
    const attempt = connection.generation.current;
    const result = await pending;
    if (interactive && result && connection.generation.current === attempt && analysisTemplateFor(result.fields)) {
      setUrl((u) => (u.page === 'source' ? { ...u, page: 'discover' } : u));
    }
    return result;
  };
  /**
   * Load a remembered source and connect to it. The time range and query are kept; filters,
   * columns, sorts and chart fields that name a field the new source does not have are dropped.
   */
  const switchSource = async (entry: SourceConfig) => {
    attemptedKey.current = rangeKeyFor(entry, url, refreshTick, compare, evaluation);
    const result = connection.select(entry, request(entry, NO_LOCAL, true, currentWindow()));
    const selection = connection.generation.current;
    const a = await result;
    if (connection.generation.current !== selection) return;
    if (!a) {
      setUrl((u) => ({ ...u, page: 'source' }));
      return;
    }
    const has = (name: string | null | undefined) => !name || !!findField(a.fields, name);
    setUrl((u) => ({
      ...u,
      page: u.page === 'source' && analysisTemplateFor(a.fields) ? 'discover' : u.page,
      search: { ...u.search, filters: u.search.filters.filter((f) => f.op === 'query' || has(f.field)) },
      discover: {
        ...u.discover,
        ...(u.discover.diff
          ? {
              diff: {
                ...u.discover.diff,
                field: has(u.discover.diff.field) ? u.discover.diff.field : null,
              },
            }
          : {}),
        columns: u.discover.columns.filter((c) => has(c)),
        sort: u.discover.sort.filter((s) => has(s.field)),
      },
      vis: {
        ...u.vis,
        x: has(u.vis.x.field) ? u.vis.x : { ...u.vis.x, field: null },
        metrics: u.vis.metrics.map((m) => (has(m.field) ? m : { ...m, field: null, agg: 'count' })),
        breakdown: has(u.vis.breakdown.field) ? u.vis.breakdown : { ...u.vis.breakdown, field: null },
      },
    }));
  };
  useEffect(() => () => connection.dispose(), [connection]);

  // Start-up: hydrate the saved source (or a known one from the link) with this session's secrets, start DuckDB, reconnect.
  useEffect(() => {
    void (async () => {
      try {
        const known = linkSource ? history.find((h) => h.key === sourceKey(linkSource)) : undefined;
        const cfg = await withSecrets(
          known && linkSource ? sourceForKnownLink(linkSource, known.config) : loadSource(),
        );
        connection.restore(cfg);
        await initDuckDB();
        expose({
          query,
          cancelAllQueries,
          queriesRunning,
          getQueryLog,
          registerFileURL: (name: string, url: string) => getDB().registerFileURL(name, url, DataProtocol.HTTP, false),
        });
        setReady(true);
        if (cfg.kind === 'local' && !cfg.localId) {
          setUrl((u) => ({ ...u, page: 'source' }));
          return;
        }
        if (cfg.kind === 'url' && cfg.authMode === 'oidc' && !isUsable(await loadCredentials(cfg.oidc), 60)) {
          // needs an interactive login: let the user click "Sign in" on the Data source page
          setUrl((u) => ({ ...u, page: 'source' }));
          return;
        }
        if (cfg.kind === 'url' && cfg.authMode === 'static' && cfg.s3.accessKeyId && !cfg.s3.secretAccessKey) {
          // the secret lives for the browser session only: after a restart it has to be entered
          // again, and connecting without it would sign with an empty key and show a bare 403
          setUrl((u) => ({ ...u, page: 'source' }));
          return;
        }
        const a = await connect(cfg, NO_LOCAL, false);
        if (!a) setUrl((u) => ({ ...u, page: 'source' }));
      } catch (e) {
        setInitError(describeError(e));
      }
    })();
    // runs once, with the source saved from the previous session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sources with date tokens ({yyyy}/{MM}/{dd}) or captured columns depend on the time range and
  // the filters: re-resolve the file list whenever they differ from what the last attempt used
  // (debounced; the pages pause their queries meanwhile). A change made while a connect is
  // running is picked up as soon as that connect ends, because the effect also runs when
  // `attaching` flips; comparing against the attempted key (not the last successful one) keeps a
  // failing source from reconnecting in a loop.
  const rangeKey = rangeKeyFor(source, url, refreshTick, compare, evaluation);
  if (!attemptedKey.current) attemptedKey.current = rangeKey;
  const resolutionPending =
    !!attached && (attached.rangeDependent || attached.captures.length > 0) && attemptedKey.current !== rangeKey;
  useEffect(() => {
    if (attaching || attemptedKey.current === rangeKey) return;
    const dependent = attached?.rangeDependent || (attached?.captures.length ?? 0) > 0;
    if (!dependent) {
      attemptedKey.current = rangeKey;
      return;
    }
    // The e2e suites wait for this instead of guessing how long the debounce takes; it stays set
    // until the re-resolve is over, so a subset of it is never mistaken for an idle app.
    expose({ resolvePending: true });
    const timer = setTimeout(() => {
      connect(source, NO_LOCAL, false, currentWindow())
        .catch(() => undefined)
        .finally(() => expose({ resolvePending: false }));
    }, 250);
    return () => {
      clearTimeout(timer);
      expose({ resolvePending: false });
    };
    // the range and the filters are compared through rangeKey; `source` only matters when they changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey, attaching]);

  return {
    ready,
    initError,
    source,
    formSource: pendingSource ?? source,
    history,
    switchSeq,
    attached,
    attachError,
    attaching: attaching || resolutionPending,
    attachProgress,
    largeConfirm,
    variables,
    creds,
    setCreds,
    connectionGeneration: connection.generation,
    ackedFiles,
    connect,
    switchSource,
    forget,
    cancelConnect: connection.cancel,
    onTimeField,
  };
}
