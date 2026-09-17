import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { t, tx, useLang } from './i18n';
import { useSettings } from './settings';
import { Dashboard } from './components/Dashboard';
import { DataSource } from './components/DataSource';
import { Discover } from './components/Discover';
import { ShareButton } from './components/ShareButton';
import { SqlPage } from './components/SqlPage';
import { Visualize } from './components/Visualize';
import { Settings } from './components/Settings';
import { fmtBytes } from './cache';
import { resolveRange } from './datemath';
import { expose } from './debug';
import { timeExprFor, type Field } from './fields';
import { useAutoRefresh } from './hooks/useAutoRefresh';
import { useConnect } from './hooks/useConnect';
import { useCredentialRefresh } from './hooks/useCredentialRefresh';
import { useDownloadGate } from './hooks/useDownloadGate';
import { describeSource, sourceKey } from './sources';
import { DEFAULT_VIS, type VisState, readLinkSource, readUrlState, shareLink, syncUrlStateFromLocation, writeUrlState, type AppPage, type UrlState } from './state';

export function App() {
  // Re-render the whole tree when the UI language changes (every t() call reads the current one).
  useLang();
  const settings = useSettings();
  const [url, setUrl] = useState<UrlState>(() => readUrlState());
  // the data source a shared link carries: read before the first writeUrlState drops it from the hash
  const [linkSource] = useState(() => readLinkSource());
  const [linkIgnored, setLinkIgnored] = useState(false);
  // Discover / Visualize query in flight: DuckDB steps of a connect queue behind it.
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  // What auto refresh waits for. A connect is DuckDB work as well, and a tick during one would
  // queue a second re-list behind it whose first act is to cancel the queries the tick just
  // started, so on a source that lists slower than the interval nothing ever finishes.
  const refreshBusyRef = useRef(false);

  useEffect(() => {
    writeUrlState(url);
  }, [url]);

  // Keyboard shortcuts outside of form controls: "/" focuses the search, "[" and "]" move the time range by its length.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if (e.key === '/') {
        const input = document.querySelector<HTMLInputElement>('.qinput input');
        if (!input) return;
        e.preventDefault();
        input.focus();
        input.select();
      } else if (e.key === '[' || e.key === ']') {
        const r = resolveRange(url.search.range);
        if (!r) return;
        const shift = (e.key === '[' ? -1 : 1) * (r.to.getTime() - r.from.getTime());
        const range = { from: new Date(r.from.getTime() + shift).toISOString(), to: new Date(r.to.getTime() + shift).toISOString() };
        setUrl((u) => ({ ...u, search: { ...u.search, range } }));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [url.search.range]);

  useEffect(() => {
    // Back / Forward (and manual hash edits): restore the whole state from the URL
    const onHash = () => {
      const { state, full } = syncUrlStateFromLocation();
      setUrl((cur) => (full ? state : state.page !== cur.page ? { ...cur, page: state.page } : cur));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refreshTick = useAutoRefresh(settings.autoRefreshMs, url.page === 'discover' || url.page === 'visualize' || url.page === 'dashboard', refreshBusyRef);
  const {
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
  } = useConnect(url, setUrl, busyRef, linkSource, refreshTick);
  refreshBusyRef.current = busy || attaching;
  const { gate, runAnyway } = useDownloadGate(source, attached, ackedFiles);
  const { refreshError } = useCredentialRefresh(source, attached, setCreds);
  const paused = attaching || gate.status !== 'ok';
  // A source from a link that was never connected here is offered, not connected: the banner shows where it reads from.
  const linkOffer = linkSource && !linkIgnored && !history.some((h) => h.key === sourceKey(linkSource)) ? linkSource : null;
  expose({ gate, switchSeq, attaching, shareLink: () => shareLink(url, source) });

  const fields: Field[] = attached?.fields ?? [];
  const timeField = attached?.timeField ?? null;
  const timeExpr = useMemo(() => (timeField ? timeExprFor(timeField) : null), [timeField]);

  const setPage = (page: AppPage) => setUrl({ ...url, page });

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
          <button class={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')} disabled={noSource}>
            {t('app.nav.dashboard')}
          </button>
          <button class={page === 'sql' ? 'active' : ''} onClick={() => setPage('sql')} disabled={noSource}>
            {t('app.nav.sql')}
          </button>
          <button class={page === 'source' ? 'active' : ''} onClick={() => setPage('source')}>
            {t('app.nav.source')}
          </button>
          <button class={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>
            {t('app.nav.settings')}
          </button>
        </nav>
        <span class="spacer" />
        <ShareButton link={() => shareLink(url, source)} withSource={source.kind !== 'local'} disabled={!attached} />
        {history.length > 0 && (
          <select
            class="input src-select"
            title={t('app.sources')}
            aria-label={t('app.sources')}
            value={attached ? (sourceKey(source) ?? '') : ''}
            disabled={attaching}
            onChange={(e) => {
              const key = e.currentTarget.value;
              const entry = history.find((h) => h.key === key);
              if (entry && key !== (attached ? sourceKey(source) : null)) void switchSource(entry.config);
            }}
          >
            {(!attached || !history.some((h) => h.key === sourceKey(source))) && <option value="">{attached ? source.name : t('app.status.noSource')}</option>}
            {history.map((h) => (
              <option key={h.key} value={h.key} title={h.config.kind === 'demo' ? '' : h.config.urls}>
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
      {initError && <div class="alert error page">{t('app.failedToStart', { error: initError })}</div>}
      {refreshError && page !== 'source' && (
        <div class="alert warn banner creds-refresh">
          <span class="text">{t('app.creds.refreshFailed', { error: refreshError })}</span>
          <button class="btn small primary" onClick={() => setPage('source')}>
            {t('app.nav.source')}
          </button>
        </div>
      )}
      {linkOffer && ready && !attaching && (
        <div class="alert warn banner link-source">
          <span class="text">{tx('app.link.text', { name: <b>{linkOffer.name || linkOffer.kind}</b>, detail: describeSource(linkOffer) })}</span>
          <button class="btn small primary" onClick={() => void switchSource(linkOffer)}>
            {t('app.link.connect')}
          </button>
          <button class="btn small" onClick={() => setLinkIgnored(true)}>
            {t('app.link.ignore')}
          </button>
        </div>
      )}
      {largeConfirm && (
        <div class="alert warn banner connect-confirm">
          <span class="text">
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
        <div class="alert warn banner download-gate">
          <span class="text">
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
        <DataSource
          key={switchSeq}
          config={source}
          history={history}
          attached={attached}
          error={attachError}
          busy={attaching || !ready}
          progress={attaching ? attachProgress : null}
          creds={creds}
          variables={variables}
          onConnect={(cfg, local) => connect(cfg, local, true)}
          onCancel={cancelConnect}
          onTimeField={onTimeField}
          onCreds={setCreds}
          onUseHistory={switchSource}
          onForgetHistory={forget}
        />
      )}
      {page === 'discover' && attached && (
        <Discover
          fields={fields}
          timeField={timeField}
          timeExpr={timeExpr}
          search={url.search}
          discover={url.discover}
          onSearch={(search) => setUrl((u) => ({ ...u, search }))}
          onDiscover={(discover) => setUrl((u) => ({ ...u, discover }))}
          onVisualizeField={visualizeField}
          onBusy={setBusy}
          paused={paused}
          refreshTick={refreshTick}
        />
      )}
      {page === 'visualize' && attached && (
        <Visualize
          fields={fields}
          timeField={timeField}
          timeExpr={timeExpr}
          search={url.search}
          vis={url.vis}
          onSearch={(search) => setUrl((u) => ({ ...u, search }))}
          onVis={(vis) => setUrl((u) => ({ ...u, vis }))}
          onBusy={setBusy}
          paused={paused}
          refreshTick={refreshTick}
        />
      )}
      {page === 'dashboard' && attached && (
        <Dashboard
          fields={fields}
          timeField={timeField}
          timeExpr={timeExpr}
          search={url.search}
          onSearch={(search) => setUrl((u) => ({ ...u, search }))}
          onOpen={(s) => setUrl((u) => ({ ...u, page: 'visualize', vis: s.vis, search: { ...u.search, query: s.search.query, filters: s.search.filters } }))}
          onBusy={setBusy}
          paused={paused}
          refreshTick={refreshTick}
        />
      )}
      {page === 'sql' && attached && <SqlPage fields={fields} timeExpr={timeExpr} search={url.search} onBusy={setBusy} paused={paused} />}
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
