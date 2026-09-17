import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { t, tx, useLang } from './i18n';
import { useSettings } from './settings';
import { DataSource } from './components/DataSource';
import { Discover } from './components/Discover';
import { Visualize } from './components/Visualize';
import { Settings } from './components/Settings';
import { fmtBytes } from './cache';
import { expose } from './debug';
import { timeExprFor, type Field } from './fields';
import { useConnect } from './hooks/useConnect';
import { useCredentialRefresh } from './hooks/useCredentialRefresh';
import { useDownloadGate } from './hooks/useDownloadGate';
import { DEFAULT_VIS, type VisState, readUrlState, sourceKey, syncUrlStateFromLocation, writeUrlState, type AppPage, type UrlState } from './state';

export function App() {
  // Re-render the whole tree when the UI language changes (every t() call reads the current one).
  useLang();
  useSettings();
  const [url, setUrl] = useState<UrlState>(() => readUrlState());
  // Discover / Visualize query in flight: DuckDB steps of a connect queue behind it.
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;

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
  } = useConnect(url, setUrl, busyRef);
  const { gate, runAnyway } = useDownloadGate(source, attached, ackedFiles);
  const { refreshError } = useCredentialRefresh(source, attached, setCreds);
  const paused = attaching || gate.status !== 'ok';
  expose({ gate, switchSeq, attaching });

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
      {initError && (
        <div class="alert error" style="margin:16px">
          {t('app.failedToStart', { error: initError })}
        </div>
      )}
      {refreshError && page !== 'source' && (
        <div class="alert warn creds-refresh" style="margin:16px 16px 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <span style="flex:1 1 320px">{t('app.creds.refreshFailed', { error: refreshError })}</span>
          <button class="btn small primary" onClick={() => setPage('source')}>
            {t('app.nav.source')}
          </button>
        </div>
      )}
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
        <DataSource
          config={source}
          switchSeq={switchSeq}
          history={history}
          attached={attached}
          error={attachError}
          busy={attaching || !ready}
          progress={attaching ? attachProgress : null}
          creds={creds}
          variables={variables}
          onConnect={(cfg, files) => connect(cfg, files, true)}
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
