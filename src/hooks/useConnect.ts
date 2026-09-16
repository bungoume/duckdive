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
import { DataProtocol, cancelAllQueries, getDB, initDuckDB, queriesRunning, query } from '../duck';
import { findField } from '../fields';
import { t } from '../i18n';
import { CancelledError } from '../net';
import { ensureHostPermissions } from '../permissions';
import type { TokenValue } from '../s3list';
import { forgetSecrets, storeSecrets, withSecrets } from '../secrets';
import { forgetSource, loadSource, loadSourceHistory, rememberSource, saveSource, type SourceConfig, type SourceHistoryEntry, type UrlState } from '../state';

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
 */
export function useConnect(url: UrlState, setUrl: Dispatch<StateUpdater<UrlState>>, queryBusy: { current: boolean }) {
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

  const connect = async (cfg: SourceConfig, files: File[], interactive = true, window: TimeWindow | null = currentWindow()): Promise<AttachedSource | null> => {
    const attempt = ++attemptSeq.current;
    const ctl = new AbortController();
    attemptCtl.current = ctl;
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
      const a = await attachSource(cfg, files, c, window, valueFiltersFor(cfg, url), { signal: ctl.signal, onProgress: report, confirmLarge });
      if (stale()) return null;
      // The user already accepted this file set: do not ask again at query time.
      if (confirmedLarge) ackedFiles.current = a.files.join('\n');
      expose({ attached: a });
      setDiagnoseContext(cfg.kind === 'url' ? { files: a.files, fileSizes: a.fileSizes, format: cfg.format } : null);
      setAttached(a);
      const saved = { ...cfg, timeField: a.timeField?.name ?? null };
      setSource(saved);
      saveSource(saved);
      void storeSecrets(saved);
      setHistory(rememberSource(saved));
      return a;
    } catch (e) {
      if (stale()) return null;
      setAttachError(e instanceof CancelledError ? t('app.error.cancelled') : String(e));
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
    const a = await connect(cfg, [], true);
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

  // Start-up: hydrate the saved source with this session's secrets, start DuckDB, reconnect.
  useEffect(() => {
    (async () => {
      try {
        const cfg = await withSecrets(loadSource());
        if (cfg !== source) {
          setSource(cfg);
          setSwitchSeq((n) => n + 1);
        }
        await initDuckDB();
        expose({ query, cancelAllQueries, queriesRunning, registerFileURL: (name: string, url: string) => getDB().registerFileURL(name, url, DataProtocol.HTTP, false) });
        setReady(true);
        if (cfg.kind === 'local') {
          setUrl((u) => ({ ...u, page: 'source' }));
          return;
        }
        if (cfg.kind === 'url' && cfg.authMode === 'oidc' && !isUsable(await loadCredentials(), 60)) {
          // needs an interactive login: let the user click "Sign in" on the Data source page
          setUrl((u) => ({ ...u, page: 'source' }));
          return;
        }
        const a = await connect(cfg, [], false);
        if (!a) setUrl((u) => ({ ...u, page: 'source' }));
      } catch (e) {
        setInitError(String(e));
      }
    })();
  }, []);

  // Sources with date tokens ({yyyy}/{MM}/{dd}) or captured columns depend on the time range and
  // the filters: re-resolve the file list whenever they change (debounced; the pages pause their
  // queries meanwhile).
  const rangeKey = `${url.search.range.from}|${url.search.range.to}|${JSON.stringify(valueFiltersFor(source, url))}`;
  const lastRangeKey = useRef(rangeKey);
  // A (re)connect always uses the current window and filters, so it settles the key.
  useEffect(() => {
    lastRangeKey.current = rangeKey;
  }, [attached]);
  useEffect(() => {
    if (lastRangeKey.current === rangeKey) return;
    lastRangeKey.current = rangeKey;
    const dependent = attached?.rangeDependent || (attached?.captures.length ?? 0) > 0;
    if (!dependent || attaching) return;
    const timer = setTimeout(() => {
      connect(source, [], false, currentWindow()).catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [rangeKey]);

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
