import { useEffect, useState } from 'preact/hooks';
import { t } from '../i18n';
import { fmtBytes } from '../cache';
import { FILE_ERROR, canDiagnose, diagnoseFiles, type DiagnoseReport } from '../diagnose';
import { describeError } from '../errors';
import { CancelledError } from '../net';

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
      setFailed(e instanceof CancelledError ? t('diag.cancelled') : describeError(e));
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
          {running ? t('diag.finding') : t('diag.find')}
        </button>
        <span class="hint">{running ? progress : t('diag.hint')}</span>
      </div>
      {failed && <div class="alert error">{failed}</div>}
      {report && (
        <div class="diagnose-report">
          {report.allReadable ? (
            <div class="alert ok">{t('diag.allOk', { n: report.totalFiles })}</div>
          ) : (
            <div class="alert warn">{t('diag.failing', { n: report.failing.length, queries: report.queries, truncated: report.truncated ? t('diag.truncated') : '' })}</div>
          )}
          {report.failing.map((f) => (
            <div key={f.file} class="diag-file">
              <div class="mono" style="word-break:break-all">
                {f.file}
              </div>
              <table class="kv">
                <tbody>
                  <tr>
                    <td>{t('diag.size')}</td>
                    <td>
                      {t('diag.sizeText', { listed: f.listedSize === null ? '?' : fmtBytes(f.listedSize), read: f.readSize === null ? '?' : fmtBytes(f.readSize) })}
                      {f.listedSize !== null && f.readSize !== null && f.listedSize !== f.readSize ? t('diag.mismatch') : ''}
                    </td>
                  </tr>
                  <tr>
                    <td>{t('diag.firstBytes')}</td>
                    <td class="mono">{f.head ?? '?'}</td>
                  </tr>
                  {f.gzip && (
                    <tr>
                      <td>gzip</td>
                      <td>
                        {t('diag.gzipText', {
                          magic: f.gzip.magicOk ? t('diag.ok') : t('diag.bad'),
                          method: f.gzip.method,
                          flags: f.gzip.flags.toString(16),
                          isize: f.gzip.isize.toLocaleString(),
                          inflated: f.gzip.inflated === null ? t('diag.inflateFailed', { error: f.gzip.inflateError }) : t('diag.bytes', { n: f.gzip.inflated.toLocaleString() }),
                          members: f.gzip.members || `? (${f.gzip.membersError})`,
                        })}
                      </td>
                    </tr>
                  )}
                  {f.gzip && (
                    <tr>
                      <td>{t('diag.verdict')}</td>
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
              {copied ? t('diag.copied') : t('diag.copyReport')}
            </button>
            <span class="hint">{t('diag.includes', { n: report.requestLog.length })}</span>
          </div>
          <textarea class="input mono diag-json" readOnly value={json} />
        </div>
      )}
    </div>
  );
}
