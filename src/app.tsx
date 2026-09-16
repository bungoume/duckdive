import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { t, tx, useLang } from './i18n';
import { useSettings } from './settings';
import { DataSource } from './components/DataSource';
import { Discover } from './components/Discover';
import { Visualize } from './components/Visualize';
import { Settings } from './components/Settings';
import { attachSource, discoverVariables, unselectedTokens, type AttachedSource, type LargeSourceInfo } from './datasource';
import { cancelAllQueries } from './duck';
import { setDiagnoseContext } from './diagnose';
import type { TokenValue } from './s3list';
import { fmtBytes } from './cache';
import { estimatePendingDownload, type DownloadEstimate } from './download';
import { CancelledError } from './net';
import { DataProtocol, getDB, initDuckDB, query } from './duck';
import './cache';
import { getCredentials, isUsable, loadCredentials, secondsUntilExpiry, type AwsCredentials } from './auth';
import { expose } from './debug';
import { forgetSecrets, storeSecrets, withSecrets } from './secrets';
import { applyS3, capturedColumns, requiredOrigins, type TimeWindow, type ValueFilters } from './datasource';
import { resolveRange } from './datemath';
import { ensureHostPermissions } from './permissions';
import { findField, timeExprFor, type Field } from './fields';
import { DEFAULT_VIS, type VisState, forgetSource, loadSource, loadSourceHistory, readUrlState, rememberSource, saveSource, sourceKey, syncUrlStateFromLocation, writeUrlState, type AppPage, type SourceConfig, type SourceHistoryEntry, type UrlState } from './state';

/** What the running connect is doing; `phase` decides whether Cancel is offered. */
export interface AttachProgress {
  message: string;
  phase: 'auth' | 'list' | 'db';
}

export function App() {
  // Re-render the whole tree when the UI language changes (every t() call reads the current one).
  useLang();
  useSettings();
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [url, setUrl] = useState<UrlState>(() => readUrlState());
  const [source, setSource] = useState<SourceConfig>(() => loadSource());
  // Recently connected sources (newest first) for quick switching; bumped on every successful connect.
  const [history, setHistory] = useState<SourceHistoryEntry[]>(() => loadSourceHistory());
  // Incremented when a history entry is loaded, so the Data source form picks up the new config.
  const [switchSeq, setSwitchSeq] = useState(0);
  const [attached, setAttached] = useState<AttachedSource | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachProgress, setAttachProgress] = useState<AttachProgress | null>(null);
  // Large source waiting for the user's go-ahead before DuckDB is touched.
  const [largeConfirm, setLargeConfirm] = useState<{ info: LargeSourceInfo; resolve: (ok: boolean) => void } | null>(null);
  // Values found for the {name} tokens of the pattern being configured (Data source page).
  const [variables, setVariables] = useState<{ pattern: string; values: Record<string, TokenValue[]>; listedFiles: number } | null>(null);
  const [busy, setBusy] = useState(false);
  // Query-time download guard: queries wait while the estimate runs and while it is blocked.
  const [gate, setGate] = useState<{ status: 'checking' | 'blocked' | 'ok'; estimate?: DownloadEstimate }>({ status: 'ok' });
  const gateAck = useRef('');
  // Discover / Visualize query in flight: DuckDB steps of a connect queue behind it.
  const busyRef = useRef(false);
  busyRef.current = busy;
  // The running connect attempt: its AbortController (listing / login can be cancelled) and a
  // sequence number so a cancelled or superseded attempt never applies its result.
  const attemptSeq = useRef(0);
  const attemptCtl = useRef<AbortController | null>(null);

  useEffect(() => {
    writeUrlState(url);
  }, [url]);

  useEffect(() => {
    // Back / Forward (and manual hash edits): restore the whole state from the URL
    const onHash = () => {
      const { state, full } = syncUrlStateFromLocation();
      setUrl((cur) => (full ? state : state.page !== cur.page ? { ...cur, page: state.page } : cur));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const [creds, setCreds] = useState<AwsCredentials | null>(null);

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

  /** Active "is" / "is one of" filters on columns captured from file names → file pruning. */
  const valueFiltersFor = (cfg: SourceConfig): ValueFilters => {
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
  };

  const connect = async (cfg: SourceConfig, files: File[], interactive = true, window: TimeWindow | null = currentWindow()) => {
    const attempt = ++attemptSeq.current;
    const ctl = new AbortController();
    attemptCtl.current = ctl;
    const stale = () => attemptSeq.current !== attempt;
    const report = (message: string, phase: AttachProgress['phase']) => {
      if (stale()) return;
      const note = phase === 'db' ? (busyRef.current ? t('app.note.queued') : t('app.note.inDb')) : '';
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
      const a = await attachSource(cfg, files, c, window, valueFiltersFor(cfg), { signal: ctl.signal, onProgress: report, confirmLarge });
      if (stale()) return null;
      // The user already accepted this file set: do not ask again at query time.
      if (confirmedLarge) gateAck.current = a.files.join('\n');
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

  useEffect(() => {
    (async () => {
      try {
        // the saved source carries no secrets; this session's (if any) are added before the form shows it
        const cfg = await withSecrets(loadSource());
        if (cfg !== source) {
          setSource(cfg);
          setSwitchSeq((n) => n + 1);
        }
        await initDuckDB();
        expose({ query, cancelAllQueries, registerFileURL: (name: string, url: string) => getDB().registerFileURL(name, url, DataProtocol.HTTP, false) });
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

  // Sources with date tokens ({yyyy}/{MM}/{dd}) depend on the time range: re-resolve the file
  // list whenever the range changes (debounced; the pages pause their queries meanwhile).
  const rangeKey = `${url.search.range.from}|${url.search.range.to}|${JSON.stringify(valueFiltersFor(source))}`;
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
    const t = setTimeout(() => {
      connect(source, [], false, currentWindow()).catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [rangeKey]);

  // Before the pages query a new file set, estimate what is not cached yet; hold the queries
  // when more files than the threshold would be downloaded, until the user runs them anyway.
  useEffect(() => {
    if (!attached || source.kind !== 'url') {
      setGate({ status: 'ok' });
      return;
    }
    const key = attached.files.join('\n');
    if (gateAck.current === key) {
      setGate({ status: 'ok' });
      return;
    }
    let live = true;
    setGate({ status: 'checking' });
    estimatePendingDownload(source, attached)
      .then((estimate) => live && setGate(estimate ? { status: 'blocked', estimate } : { status: 'ok' }))
      .catch(() => live && setGate({ status: 'ok' }));
    return () => {
      live = false;
    };
  }, [attached, source]);
  const runAnyway = () => {
    gateAck.current = attached?.files.join('\n') ?? '';
    setGate({ status: 'ok' });
  };
  const paused = attaching || gate.status !== 'ok';
  expose({ gate });

  // Refresh temporary credentials before they expire and push them into DuckDB.
  useEffect(() => {
    if (source.kind !== 'url' || source.authMode !== 'oidc' || !attached) return;
    const t = setInterval(async () => {
      try {
        const cur = await loadCredentials();
        if (secondsUntilExpiry(cur) > 600) return;
        const c = await getCredentials(source.oidc, false);
        setCreds(c);
        await applyS3(source, c);
      } catch (e) {
        console.warn('credential refresh failed', e);
      }
    }, 60_000);
    return () => clearInterval(t);
  }, [source, attached]);

  const fields: Field[] = attached?.fields ?? [];
  const timeField = attached?.timeField ?? null;
  const timeExpr = useMemo(() => (timeField ? timeExprFor(timeField) : null), [timeField]);

  const setPage = (page: AppPage) => setUrl({ ...url, page });
  const onTimeField = (name: string | null) => {
    if (!attached) return;
    const f = name ? findField(attached.fields, name) ?? null : null;
    setAttached({ ...attached, timeField: f });
    const cfg = { ...source, timeField: f?.name ?? null };
    setSource(cfg);
    saveSource(cfg);
  };

  const visualizeField = (f: Field) => {
    const vis: VisState = { ...DEFAULT_VIS, metrics: [{ id: 'm0', agg: 'count', field: null }] };
    if (f.kind === 'date') vis.x = { ...vis.x, kind: 'date_histogram', field: f.name };
    else if (f.kind === 'number') {
      vis.x = { ...vis.x, kind: 'date_histogram', field: null };
      vis.metrics = [{ id: 'm0', agg: 'avg', field: f.name }];
      vis.chart = 'line';
    } else {
      vis.x = { ...vis.x, kind: 'terms', field: f.name, size: 10 };
      vis.chart = 'bar';
    }
    vis.title = `${f.name}`;
    setUrl({ ...url, page: 'visualize', vis });
  };

  const noSource = !attached;
  // Without a source only the Data source and Settings pages make sense.
  const page: AppPage = noSource && url.page !== 'settings' ? 'source' : url.page;

  return (
    <div class="app">
      <header class="header">
        <div class="brand">
          <img class="logo" src="icons/icon-32.png" alt="" />
          <span>Duckdive</span>
        </div>
        <nav>
          <button class={page === 'discover' ? 'active' : ''} onClick={() => setPage('discover')} disabled={noSource}>
            {t('app.nav.discover')}
          </button>
          <button class={page === 'visualize' ? 'active' : ''} onClick={() => setPage('visualize')} disabled={noSource}>
            {t('app.nav.visualize')}
          </button>
          <button class={page === 'source' ? 'active' : ''} onClick={() => setPage('source')}>
            {t('app.nav.source')}
          </button>
          <button class={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>
            {t('app.nav.settings')}
          </button>
        </nav>
        <span class="spacer" />
        {history.length > 0 && (
          <select
            class="input src-select"
            title={t('app.sources')}
            aria-label={t('app.sources')}
            value={attached ? (sourceKey(source) ?? '') : ''}
            disabled={attaching}
            onChange={(e) => {
              const key = (e.target as HTMLSelectElement).value;
              const entry = history.find((h) => h.key === key);
              if (entry && key !== (attached ? sourceKey(source) : null)) switchSource(entry.config);
            }}
          >
            {(!attached || !history.some((h) => h.key === sourceKey(source))) && <option value="">{attached ? source.name : t('app.status.noSource')}</option>}
            {history.map((h) => (
              <option value={h.key} title={h.config.kind === 'demo' ? '' : h.config.urls}>
                {h.config.name || h.config.kind}
              </option>
            ))}
          </select>
        )}
        <span class="status">
          <span class={'dot' + (initError || attachError ? ' err' : busy || attaching || !ready ? ' busy' : '')} />
          {!ready
            ? t('app.status.starting')
            : attaching && attachProgress
              ? t('app.status.connecting', { message: attachProgress.message })
              : attached
                ? attached.rowCount !== null
                  ? t('app.status.rows', { name: source.name || t('app.status.sourceFallback'), n: attached.rowCount.toLocaleString() })
                  : t('app.status.files', { name: source.name || t('app.status.sourceFallback'), n: attached.files.length })
                : t('app.status.noSource')}
        </span>
      </header>
      {initError && <div class="alert error" style="margin:16px">{t('app.failedToStart', { error: initError })}</div>}
      {largeConfirm && (
        <div class="alert warn connect-confirm" style="margin:16px 16px 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <span style="flex:1 1 320px">
            {tx('app.large.text', {
              files: <b>{t('app.large.files', { n: largeConfirm.info.files.toLocaleString() })}</b>,
              bytes: largeConfirm.info.bytes !== null ? ` (${fmtBytes(largeConfirm.info.bytes)})` : '',
              threshold: largeConfirm.info.threshold.toLocaleString(),
            })}
          </span>
          <button class="btn small primary" onClick={() => largeConfirm.resolve(true)}>
            {t('app.large.continue', { n: largeConfirm.info.files.toLocaleString() })}
          </button>
          <button class="btn small" onClick={() => largeConfirm.resolve(false)}>
            {t('common.cancel')}
          </button>
        </div>
      )}
      {page !== 'source' && gate.status === 'blocked' && gate.estimate && (
        <div class="alert warn download-gate" style="margin:16px 16px 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <span style="flex:1 1 320px">
            {tx('app.gate.text', {
              files: <b>{t('app.gate.files', { n: gate.estimate.files.toLocaleString() })}</b>,
              threshold: gate.estimate.threshold.toLocaleString(),
              bytes: <b>{fmtBytes(gate.estimate.bytes)}</b>,
              unknown: gate.estimate.unknownSizes ? t('app.gate.unknown', { n: gate.estimate.unknownSizes.toLocaleString() }) : '',
            })}
          </span>
          <button class="btn small primary" onClick={runAnyway}>
            {t('app.gate.runAnyway')}
          </button>
        </div>
      )}
      {page === 'settings' && <Settings />}
      {page === 'source' && (
        <DataSource config={source} switchSeq={switchSeq} history={history} attached={attached} error={attachError} busy={attaching || !ready} progress={attaching ? attachProgress : null} creds={creds} variables={variables} onConnect={(cfg, files) => connect(cfg, files, true)} onCancel={cancelConnect} onTimeField={onTimeField} onCreds={setCreds} onUseHistory={switchSource} onForgetHistory={forget} />
      )}
      {page === 'discover' && attached && (
        <Discover
          fields={fields}
          timeField={timeField}
          timeExpr={timeExpr}
          search={url.search}
          discover={url.discover}
          onSearch={(search) => setUrl({ ...url, search })}
          onDiscover={(discover) => setUrl({ ...url, discover })}
          onVisualizeField={visualizeField}
          onBusy={setBusy}
          paused={paused}
        />
      )}
      {page === 'visualize' && attached && (
        <Visualize
          fields={fields}
          timeField={timeField}
          timeExpr={timeExpr}
          search={url.search}
          vis={url.vis}
          onSearch={(search) => setUrl({ ...url, search })}
          onVis={(vis) => setUrl({ ...url, vis })}
          onBusy={setBusy}
          paused={paused}
        />
      )}
      {!ready && !initError && (
        <div class="overlay">
          <div>
            <div class="spinner" />
            {t('app.status.starting')}
          </div>
        </div>
      )}
    </div>
  );
}
