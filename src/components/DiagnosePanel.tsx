import { useEffect, useState } from 'preact/hooks';
import { fmtBytes } from '../cache';
import { FILE_ERROR, canDiagnose, diagnoseFiles, type DiagnoseReport } from '../diagnose';
import { QueryCancelled } from '../duck';

/** Shown under a query error that smells like damaged file bytes: finds and inspects the culprit file(s). */
export function DiagnosePanel(props: { error: string | null }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [report, setReport] = useState<DiagnoseReport | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setReport(null);
    setFailed(null);
  }, [props.error]);
  if (!props.error || !FILE_ERROR.test(props.error) || !canDiagnose()) return null;

  const run = async () => {
    setRunning(true);
    setReport(null);
    setFailed(null);
    try {
      setReport(await diagnoseFiles(setProgress));
    } catch (e) {
      setFailed(e instanceof QueryCancelled ? 'Cancelled (the source was reconnected)' : String(e));
    } finally {
      setRunning(false);
    }
  };
  const json = report ? JSON.stringify({ error: props.error, ...report }, null, 2) : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: the JSON is visible in the textarea below */
    }
  };
  return (
    <div class="diagnose">
      <div class="row">
        <button class="btn small" disabled={running} onClick={run}>
          {running ? 'Finding the failing file…' : 'Find the failing file'}
        </button>
        <span class="hint">{running ? progress : 'Bisects the attached files with count(*) queries and inspects the bytes of each culprit (about two full scans per culprit).'}</span>
      </div>
      {failed && <div class="alert error">{failed}</div>}
      {report && (
        <div class="diagnose-report">
          {report.allReadable ? (
            <div class="alert ok">
              All {report.totalFiles} file(s) read fine with count(*) just now. The failure is either transient (a bad answer from the network or the cache: see the request log under
              Data source → Local range cache) or specific to the failing query.
            </div>
          ) : (
            <div class="alert warn">
              {report.failing.length} failing file(s) found in {report.queries} queries{report.truncated ? ' (stopped after the first few)' : ''}.
            </div>
          )}
          {report.failing.map((f) => (
            <div class="diag-file">
              <div class="mono" style="word-break:break-all">
                {f.file}
              </div>
              <table class="kv">
                <tbody>
                  <tr>
                    <td>size</td>
                    <td>
                      listed {f.listedSize === null ? '?' : fmtBytes(f.listedSize)} / read {f.readSize === null ? '?' : fmtBytes(f.readSize)}
                      {f.listedSize !== null && f.readSize !== null && f.listedSize !== f.readSize ? ' (MISMATCH: the object changed since it was listed)' : ''}
                    </td>
                  </tr>
                  <tr>
                    <td>first bytes</td>
                    <td class="mono">{f.head ?? '?'}</td>
                  </tr>
                  {f.gzip && (
                    <tr>
                      <td>gzip</td>
                      <td>
                        magic {f.gzip.magicOk ? 'ok' : 'BAD'}, method {f.gzip.method}, flags 0x{f.gzip.flags.toString(16)}, trailer ISIZE {f.gzip.isize.toLocaleString()}, browser inflated{' '}
                        {f.gzip.inflated === null ? `failed (${f.gzip.inflateError})` : `${f.gzip.inflated.toLocaleString()} bytes`}, members {f.gzip.members || `? (${f.gzip.membersError})`}
                      </td>
                    </tr>
                  )}
                  {f.gzip && (
                    <tr>
                      <td>verdict</td>
                      <td>
                        <b>{f.gzip.verdict}</b>
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td>DuckDB</td>
                    <td class="mono" style="white-space:pre-wrap">
                      {f.error}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
          <div class="row">
            <button class="btn small" onClick={copy}>
              {copied ? 'Copied' : 'Copy report (JSON)'}
            </button>
            <span class="hint">Includes the matching lines of the worker request log ({report.requestLog.length}).</span>
          </div>
          <textarea class="input mono diag-json" readOnly value={json} />
        </div>
      )}
    </div>
  );
}
