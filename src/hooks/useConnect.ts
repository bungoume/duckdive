// Everything about attaching a data source: the saved configuration and the history of recent
// ones, the running connect attempt (cancellable while it lists or signs in), the large-source
// confirmation, pattern-variable discovery, the start-up connect and the re-connects that a
// changed time range or captured-column filter requires.

import { useEffect, useRef, useState, type Dispatch, type StateUpdater } from 'preact/hooks';
import { getCredentials, isUsable, loadCredentials, type AwsCredentials } from '../auth';
import { attachSource, capturedColumns, discoverVariables, requiredOrigins, unselectedTokens, type AttachedSource, type LargeSourceInfo, type TimeWindow, type ValueFilters } from '../datasource';
import { resolveRange } from '../datemath';
import { expose } from '../debug';
import { setDiagnoseContext } from '../diagnose';
import { describeError } from '../errors';
import { DataProtocol, cancelAllQueries, getDB, getQueryLog, initDuckDB, queriesRunning, query } from '../duck';
import { findField } from '../fields';
import { t } from '../i18n';
import { NO_LOCAL, forgetHandles, openLocal, storeHandles, type LocalSelection } from '../localfiles';
import { CancelledError } from '../net';
import { ensureHostPermissions } from '../permissions';
import type { TokenValue } from '../s3list';
import { forgetSecrets, storeSecrets, withSecrets } from '../secrets';
import { forgetSource, loadSource, loadSourceHistory, rememberSource, saveSource, sourceKey, type SourceConfig, type SourceHistoryEntry } from '../sources';
import { newId } from '../sql';
import { type UrlState } from '../state';

/** What the running connect is doing; `phase` decides whether Cancel is offered. */
export interface AttachProgress {
  message: string;
  phase: 'auth' | 'list' | 'db';
}

/** Values found for the {name} tokens of the pattern being configured (Data source page). */
export interface Variables {
  pattern: string;
  values: Record<string, TokenValue[]>;
  listedFiles: number;
}

/** A large source waiting for the user's go-ahead before DuckDB is touched. */
export interface LargeConfirm {
  info: LargeSourceInfo;
  resolve: (ok: boolean) => void;
}

/** What a file resolution depends on: the time range and the captured-column filters of `cfg`, and the auto-refresh tick (new files may have arrived). */
function rangeKeyFor(cfg: SourceConfig, url: UrlState, tick: number): string {
  return `${url.search.range.from}|${url.search.range.to}|${JSON.stringify(valueFiltersFor(cfg, url))}|${tick}`;
}

/** Active "is" / "is one of" filters on columns captured from file names → file pruning. */
export function valueFiltersFor(cfg: SourceConfig, url: UrlState): ValueFilters {
  const names = capturedColumns(cfg);
  const out: ValueFilters = {};
  if (!names.length) return out;
  for (const f of url.search.filters) {
    if (f.disabled || f.negate || !names.includes(f.field)) continue;
    const vals = f.op === 'is' && f.value !== undefined ? [f.value] : f.op === 'is_one_of' ? (f.values ?? []) : null;
    if (!vals || !vals.length) continue;
    out[f.field] = out[f.field] ? out[f.field].filter((v) => vals.includes(v)) : vals;
  }
  return out;
}

/**
 * @param url current URL state (time range and filters feed the file resolution)
 * @param setUrl for page switches and for dropping state that a new source cannot satisfy
 * @param queryBusy whether a Discover / Visualize query is in flight (DuckDB steps queue behind it)
 * @param linkSource the source a shared link carries: connected at start-up instead of the saved one when it is already known here
 * @param refreshTick advances on auto refresh: sources whose file list depends on the time range re-list it
 */
export function useConnect(url: UrlState, setUrl: Dispatch<StateUpdater<UrlState>>, queryBusy: { current: boolean }, linkSource: SourceConfig | null = null, refreshTick = 0) {
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [source, setSource] = useState<SourceConfig>(() => loadSource());
  // Recently connected sources (newest first) for quick switching; bumped on every successful connect.
  const [history, setHistory] = useState<SourceHistoryEntry[]>(() => loadSourceHistory());
  // Incremented when a remembered source is loaded, so the Data source form picks up the new config.
  const [switchSeq, setSwitchSeq] = useState(0);
  const [attached, setAttached] = useState<AttachedSource | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachProgress, setAttachProgress] = useState<AttachProgress | null>(null);
  const [largeConfirm, setLargeConfirm] = useState<LargeConfirm | null>(null);
  const [variables, setVariables] = useState<Variables | null>(null);
  const [creds, setCreds] = useState<AwsCredentials | null>(null);
  /** The file set (joined) the user accepted in the large-source confirmation: the download gate skips it. */
  const ackedFiles = useRef('');
  // The running connect attempt: its AbortController (listing / login can be cancelled) and a
  // sequence number so a cancelled or superseded attempt never applies its result.
  const attemptSeq = useRef(0);
  const attemptCtl = useRef<AbortController | null>(null);
  /** The range / filter key the last connect attempt resolved files for (see the effect below). */
  const attemptedKey = useRef('');

  /** Credentials for cfg (null for static / none). Interactive login only when `interactive`. */
  const resolveCreds = async (cfg: SourceConfig, interactive: boolean): Promise<AwsCredentials | null> => {
    if (cfg.kind !== 'url' || cfg.authMode !== 'oidc') return null;
    const c = await getCredentials(cfg.oidc, interactive);
    setCreds(c);
    return c;
  };

  const currentWindow = (): TimeWindow | null => {
    const r = resolveRange(url.search.range);
    return r ? { from: r.from, to: r.to } : null;
  };

  const connect = async (cfg: SourceConfig, local: LocalSelection = NO_LOCAL, interactive = true, window: TimeWindow | null = currentWindow()): Promise<AttachedSource | null> => {
    // Whatever was still connecting belongs to a file set nobody wants any more. Without this its
    // listing runs to the end and then replaces the view with the older file set, because only
    // the state updates check `stale()` while the DuckDB steps do not.
    attemptCtl.current?.abort();
    const attempt = ++attemptSeq.current;
    const ctl = new AbortController();
    attemptCtl.current = ctl;
    attemptedKey.current = rangeKeyFor(cfg, url, refreshTick);
    const stale = () => attemptSeq.current !== attempt;
    const report = (message: string, phase: AttachProgress['phase']) => {
      if (stale()) return;
      const note = phase === 'db' ? (queryBusy.current ? t('app.note.queued') : t('app.note.inDb')) : '';
      setAttachProgress({ message: message + note, phase });
    };
    setAttaching(true);
    setAttachError(null);
    setAttachProgress(null);
    let confirmedLarge = false;
    const confirmLarge = (info: LargeSourceInfo) =>
      new Promise<boolean>((resolve) => {
        setLargeConfirm({
          info,
          resolve: (ok) => {
            setLargeConfirm(null);
            confirmedLarge = ok;
            resolve(ok);
          },
        });
      });
    try {
      // A remembered local source: its files come from the stored handles (Chrome may ask for permission).
      let sel = local;
      if (cfg.kind === 'local' && !sel.files.length && cfg.localId) {
        report(t('app.progress.openingLocal'), 'list');
        const opened = await openLocal(cfg.localId, interactive);
        if (stale()) return null;
        if (!opened) {
          setUrl((u) => ({ ...u, page: 'source' }));
          return null;
        }
        sel = opened;
      }
      if (cfg.kind === 'url') {
        const perm = await ensureHostPermissions(requiredOrigins(cfg));
        if (!perm.ok) throw new Error(t('app.error.hostPermission', { origins: perm.missing.join(', ') }));
      }
      if (cfg.kind === 'url' && cfg.authMode === 'oidc') report(interactive ? t('app.progress.signingIn') : t('app.progress.refreshingCreds'), 'auth');
      const c = await resolveCreds(cfg, interactive);
      if (stale()) return null;
      // Patterns with {name} tokens: list the values first and let the user choose before any file is read.
      if (cfg.kind === 'url' && unselectedTokens(cfg).length) {
        report(t('app.progress.listingVars'), 'list');
        const found = await discoverVariables(cfg, c, window, { signal: ctl.signal, onProgress: report });
        if (stale()) return null;
        setVariables({ pattern: cfg.urls, ...found });
        setUrl((u) => ({ ...u, page: 'source' }));
        return null;
      }
      // Whatever is still running belongs to the previous file set: stop it so the new view
      // is not queued behind it.
      report(t('app.progress.stopping'), 'list');
      await cancelAllQueries();
      if (stale()) return null;
      const a = await attachSource(cfg, sel.files, c, window, valueFiltersFor(cfg, url), { signal: ctl.signal, onProgress: report, confirmLarge });
      if (stale()) return null;
      // The user already accepted this file set: do not ask again at query time.
      if (confirmedLarge) ackedFiles.current = a.files.join('\n');
      expose({ attached: a });
      setDiagnoseContext(cfg.kind === 'url' ? { files: a.files, fileSizes: a.fileSizes, format: cfg.format } : null);
      setAttached(a);
      const saved: SourceConfig = { ...cfg, timeField: a.timeField?.name ?? null };
      if (cfg.kind === 'local' && sel.handles.length) {
        // picked with handles: keep them so the source can be reopened from the history
        saved.localId = cfg.localId ?? newId();
        await storeHandles(saved.localId, sel.handles);
      }
      setSource(saved);
      saveSource(saved);
      void storeSecrets(saved);
      setHistory(rememberSource(saved));
      return a;
    } catch (e) {
      if (stale()) return null;
      setAttachError(e instanceof CancelledError ? t('app.error.cancelled') : describeError(e));
      return null;
    } finally {
      if (!stale()) {
        setAttaching(false);
        setAttachProgress(null);
        setLargeConfirm(null);
      }
    }
  };

  /**
   * Load a remembered source and connect to it. The time range and query are kept; filters,
   * columns, sorts and chart fields that name a field the new source does not have are dropped.
   */
  const switchSource = async (entry: SourceConfig) => {
    const cfg = await withSecrets(entry);
    setSource(cfg);
    setSwitchSeq((n) => n + 1);
    const a = await connect(cfg, NO_LOCAL, true);
    if (!a) {
      setUrl((u) => ({ ...u, page: 'source' }));
      return;
    }
    const has = (name: string | null | undefined) => !name || !!findField(a.fields, name);
    setUrl((u) => ({
      ...u,
      search: { ...u.search, filters: u.search.filters.filter((f) => f.op === 'query' || has(f.field)) },
      discover: { ...u.discover, columns: u.discover.columns.filter((c) => has(c)), sort: u.discover.sort.filter((s) => has(s.field)) },
      vis: {
        ...u.vis,
        x: has(u.vis.x.field) ? u.vis.x : { ...u.vis.x, field: null },
        metrics: u.vis.metrics.map((m) => (has(m.field) ? m : { ...m, field: null, agg: 'count' })),
        breakdown: has(u.vis.breakdown.field) ? u.vis.breakdown : { ...u.vis.breakdown, field: null },
      },
    }));
  };

  const forget = (key: string) => {
    const localId = history.find((h) => h.key === key)?.config.localId;
    if (localId) void forgetHandles(localId);
    setHistory(forgetSource(key));
    void forgetSecrets(key);
  };

  /** Abandon the running connect. Only listing / login can be cut short; a DuckDB step runs on. */
  const cancelConnect = () => {
    if (!attaching || attachProgress?.phase === 'db') return;
    largeConfirm?.resolve(false);
    attemptSeq.current++;
    attemptCtl.current?.abort();
    setAttaching(false);
    setAttachProgress(null);
    setAttachError(t('app.error.cancelled'));
  };

  const onTimeField = (name: string | null) => {
    if (!attached) return;
    const f = name ? (findField(attached.fields, name) ?? null) : null;
    setAttached({ ...attached, timeField: f });
    const cfg = { ...source, timeField: f?.name ?? null };
    setSource(cfg);
    saveSource(cfg);
  };

  // Start-up: hydrate the saved source (or a known one from the link) with this session's secrets, start DuckDB, reconnect.
  useEffect(() => {
    void (async () => {
      try {
        const known = linkSource ? history.find((h) => h.key === sourceKey(linkSource)) : undefined;
        const cfg = await withSecrets(known ? known.config : loadSource());
        setSource(cfg);
        setSwitchSeq((n) => n + 1);
        await initDuckDB();
        expose({ query, cancelAllQueries, queriesRunning, getQueryLog, registerFileURL: (name: string, url: string) => getDB().registerFileURL(name, url, DataProtocol.HTTP, false) });
        setReady(true);
        if (cfg.kind === 'local' && !cfg.localId) {
          setUrl((u) => ({ ...u, page: 'source' }));
          return;
        }
        if (cfg.kind === 'url' && cfg.authMode === 'oidc' && !isUsable(await loadCredentials(), 60)) {
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
  const rangeKey = rangeKeyFor(source, url, refreshTick);
  if (!attemptedKey.current) attemptedKey.current = rangeKey;
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
    history,
    switchSeq,
    attached,
    attachError,
    attaching,
    attachProgress,
    largeConfirm,
    variables,
    creds,
    setCreds,
    ackedFiles,
    connect,
    switchSource,
    forget,
    cancelConnect,
    onTimeField,
  };
}
