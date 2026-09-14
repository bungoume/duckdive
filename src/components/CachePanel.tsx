import { useEffect, useState } from 'preact/hooks';
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
      <h2>Local range cache</h2>
      <p class="hint" style="margin-top:-6px">
        Data that has been read once is kept on this machine, so repeated queries do not download it again. Only parts that were never read are fetched. The copy is discarded when the file changes in storage.
      </p>
      {err && <div class="alert error">{err}</div>}
      {opfsError && <div class="alert error">{opfsError} – caching is disabled, every read goes to the origin.</div>}
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
              Enable range cache
            </label>
            <label class="row" title="AWS log delivery sometimes writes gzip files that cannot be read reliably as-is. When enabled, each .gz file is fetched once at connect time, fixed if needed, and kept in the cache.">
              <input
                type="checkbox"
                checked={config.normalizeGzip}
                onChange={async (e) => {
                  await cacheSetConfig({ normalizeGzip: (e.target as HTMLInputElement).checked });
                  refresh();
                }}
              />
              Re-pack concatenated gzip files at connect
            </label>
            <div class="row">
              <span class="hint">Chunk size (new files)</span>
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
                <td class="k">This session</td>
                <td class="v">
                  DuckDB read {fmtBytes(total)}: {fmtBytes(stats?.bytesFromCache ?? 0)} from disk ({ratio}%) · downloaded {fmtBytes(stats?.bytesDownloaded ?? 0)} from origin in {stats?.chunkMisses ?? 0} chunks · {stats?.chunkHits ?? 0} chunk hits · {stats?.passthrough ?? 0} passthrough
                </td>
              </tr>
              <tr>
                <td class="k">Storage</td>
                <td class="v">
                  {est ? `${fmtBytes(est.usage)} used of ${fmtBytes(est.quota)} quota · ${est.persisted ? 'persistent' : 'best-effort (may be evicted)'}` : '–'}
                  {est && !est.persisted && (
                    <button
                      class="btn small"
                      style="margin-left:8px"
                      onClick={async () => {
                        await requestPersist();
                        refresh();
                      }}
                    >
                      Request persistent storage
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
                  <td class="k">On disk</td>
                  <td class="v">
                    {summary.cachedFiles.toLocaleString()} file(s) with cached data, {fmtBytes(summary.cachedBytes)} · metadata for {summary.known.toLocaleString()} file(s)
                    {summary.wasted > 0 ? ` · ${fmtBytes(summary.wasted)} reclaimable` : ''}
                    {summary.wasted > 16 * 1024 * 1024 && (
                      <button
                        class="btn small"
                        style="margin-left:8px"
                        onClick={async () => {
                          await cacheCompact();
                          refresh();
                        }}
                      >
                        Compact
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
                  <th>File</th>
                  <th>Size</th>
                  <th>Cached</th>
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
                        Drop
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {summary && summary.cachedFiles > files.length && (
            <div class="hint" style="margin-bottom:8px">
              Showing the {files.length} largest of {summary.cachedFiles.toLocaleString()} cached files.{' '}
              <button class="btn ghost small" onClick={() => setLimit(limit + 200)}>
                Show more
              </button>
            </div>
          )}
          {stats && stats.log.length > 0 && (
            <details class="cache-log-box" style="margin-bottom:8px">
              <summary>
                Request log (last {stats.log.length}; {stats.log.filter((l) => /corrupt|short-body|passthrough:|handler-error|range-ignored/.test(l.outcome)).length} anomalies)
              </summary>
              <div class="row end" style="margin:4px 0">
                <button
                  class="btn ghost small"
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(stats.log, null, 2)).catch(() => {});
                  }}
                >
                  Copy log (JSON)
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
              Refresh
            </button>
            <button
              class="btn small danger"
              onClick={async () => {
                await cacheClear();
                refresh();
              }}
            >
              Clear cache
            </button>
          </div>
        </>
      )}
    </div>
  );
}
