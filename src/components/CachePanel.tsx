import { useEffect, useState } from 'preact/hooks';
import { t } from '../i18n';
import { cacheClear, cacheCompact, cacheFiles, cachePurge, cacheSetConfig, cacheStats, fmtBytes, requestPersist, storageEstimate, type CacheConfig, type CacheStats, type CacheSummary, type CachedFile } from '../cache';

const CHUNK_SIZES = [
  { v: 256 * 1024, l: '256 KB' },
  { v: 512 * 1024, l: '512 KB' },
  { v: 1024 * 1024, l: '1 MB' },
  { v: 2 * 1024 * 1024, l: '2 MB' },
  { v: 4 * 1024 * 1024, l: '4 MB' },
  { v: 8 * 1024 * 1024, l: '8 MB' },
];

export function CachePanel() {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [config, setConfig] = useState<CacheConfig | null>(null);
  const [files, setFiles] = useState<CachedFile[]>([]);
  const [summary, setSummary] = useState<CacheSummary | null>(null);
  const [limit, setLimit] = useState(50);
  const [est, setEst] = useState<{ usage: number; quota: number; persisted: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [opfsError, setOpfsError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [s, f, e] = await Promise.all([cacheStats(), cacheFiles({ limit }), storageEstimate()]);
      setStats(s.stats);
      setConfig(s.config);
      setOpfsError(s.opfsError);
      setFiles(f.files);
      setSummary(f.summary);
      setEst(e);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [limit]);

  const total = (stats?.bytesFromCache ?? 0) + (stats?.bytesFromNetwork ?? 0);
  const ratio = total ? Math.round(((stats?.bytesFromCache ?? 0) / total) * 100) : 0;

  return (
    <div class="card">
      <h2>{t('cache.title')}</h2>
      <p class="hint" style="margin-top:-6px">
        {t('cache.intro')}
      </p>
      {err && <div class="alert error">{err}</div>}
      {opfsError && <div class="alert error">{t('cache.opfsDisabled', { error: opfsError })}</div>}
      {config && (
        <>
          <div class="grid2" style="margin-bottom:8px">
            <label class="row">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={async (e) => {
                  await cacheSetConfig({ enabled: (e.target as HTMLInputElement).checked });
                  refresh();
                }}
              />
              {t('cache.enable')}
            </label>
            <label class="row" title={t('cache.repack.title')}>
              <input
                type="checkbox"
                checked={config.normalizeGzip}
                onChange={async (e) => {
                  await cacheSetConfig({ normalizeGzip: (e.target as HTMLInputElement).checked });
                  refresh();
                }}
              />
              {t('cache.repack')}
            </label>
            <div class="row">
              <span class="hint">{t('cache.chunkSize')}</span>
              <select
                class="input"
                style="width:120px"
                value={config.chunkSize}
                onChange={async (e) => {
                  await cacheSetConfig({ chunkSize: Number((e.target as HTMLSelectElement).value) });
                  refresh();
                }}
              >
                {CHUNK_SIZES.map((c) => (
                  <option value={c.v}>{c.l}</option>
                ))}
              </select>
            </div>
          </div>
          <table class="kv" style="margin-bottom:8px">
            <tbody>
              <tr>
                <td class="k">{t('cache.session')}</td>
                <td class="v">
                  {t('cache.session.text', { total: fmtBytes(total), fromCache: fmtBytes(stats?.bytesFromCache ?? 0), ratio, downloaded: fmtBytes(stats?.bytesDownloaded ?? 0), misses: stats?.chunkMisses ?? 0, hits: stats?.chunkHits ?? 0, passthrough: stats?.passthrough ?? 0 })}
                </td>
              </tr>
              <tr>
                <td class="k">{t('cache.storage')}</td>
                <td class="v">
                  {est ? t('cache.storage.text', { used: fmtBytes(est.usage), quota: fmtBytes(est.quota), mode: est.persisted ? t('cache.storage.persistent') : t('cache.storage.bestEffort') }) : '–'}
                  {est && !est.persisted && (
                    <button
                      class="btn small"
                      style="margin-left:8px"
                      onClick={async () => {
                        await requestPersist();
                        refresh();
                      }}
                    >
                      {t('cache.requestPersist')}
                    </button>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
          {summary && (
            <table class="kv" style="margin-bottom:8px">
              <tbody>
                <tr>
                  <td class="k">{t('cache.onDisk')}</td>
                  <td class="v">
                    {t('cache.onDisk.text', { files: summary.cachedFiles.toLocaleString(), bytes: fmtBytes(summary.cachedBytes), known: summary.known.toLocaleString() })}
                    {summary.wasted > 0 ? t('cache.reclaimable', { bytes: fmtBytes(summary.wasted) }) : ''}
                    {summary.wasted > 16 * 1024 * 1024 && (
                      <button
                        class="btn small"
                        style="margin-left:8px"
                        onClick={async () => {
                          await cacheCompact();
                          refresh();
                        }}
                      >
                        {t('cache.compact')}
                      </button>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
          {files.length > 0 && (
            <table class="data" style="margin-bottom:8px">
              <thead>
                <tr>
                  <th>{t('cache.th.file')}</th>
                  <th>{t('cache.th.size')}</th>
                  <th>{t('cache.th.cached')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr>
                    <td class="mono" style="word-break:break-all">{f.url}</td>
                    <td class="num">{fmtBytes(f.size)}</td>
                    <td class="num">
                      {fmtBytes(f.cachedBytes)} ({f.size ? Math.min(100, Math.round((f.cachedBytes / f.size) * 100)) : 0}%)
                    </td>
                    <td>
                      <button
                        class="btn small"
                        onClick={async () => {
                          await cachePurge(f.url);
                          refresh();
                        }}
                      >
                        {t('cache.drop')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {summary && summary.cachedFiles > files.length && (
            <div class="hint" style="margin-bottom:8px">
              {t('cache.showing', { n: files.length, total: summary.cachedFiles.toLocaleString() })}{' '}
              <button class="btn ghost small" onClick={() => setLimit(limit + 200)}>
                {t('cache.showMore')}
              </button>
            </div>
          )}
          {stats && stats.log.length > 0 && (
            <details class="cache-log-box" style="margin-bottom:8px">
              <summary>
                {t('cache.log.summary', { n: stats.log.length, anomalies: stats.log.filter((l) => /corrupt|short-body|passthrough:|handler-error|range-ignored/.test(l.outcome)).length })}
              </summary>
              <div class="row end" style="margin:4px 0">
                <button
                  class="btn ghost small"
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(stats.log, null, 2)).catch(() => {});
                  }}
                >
                  {t('cache.log.copy')}
                </button>
              </div>
              <div class="cache-log">
                <table class="kv">
                  <tbody>
                    {[...stats.log].reverse().map((l) => (
                      <tr class={/corrupt|short-body|passthrough:|handler-error|range-ignored/.test(l.outcome) ? 'warn' : ''}>
                        <td>{new Date(l.t).toLocaleTimeString()}</td>
                        <td>{l.method}</td>
                        <td class="mono url" title={l.url}>
                          {l.url.split('/').pop()}
                        </td>
                        <td class="mono">{l.range ?? ''}</td>
                        <td>{l.outcome}</td>
                        <td>{l.status ?? ''}</td>
                        <td class="num">{l.bytes === undefined ? '' : fmtBytes(l.bytes)}</td>
                        <td class="mono">{l.head ?? ''}</td>
                        <td>{l.enc ? `enc=${l.enc}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          <div class="row end">
            <button class="btn small" onClick={refresh}>
              {t('common.refresh')}
            </button>
            <button
              class="btn small danger"
              onClick={async () => {
                await cacheClear();
                refresh();
              }}
            >
              {t('cache.clear')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
