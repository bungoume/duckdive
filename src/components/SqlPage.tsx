import { useEffect, useRef, useState } from 'preact/hooks';
import { cancelAllQueries, query, type Row } from '../duck';
import { describeError } from '../errors';
import { EXPORT_FORMATS, downloadBlob, exportFileName, exportToBlob, type ExportFormat } from '../export';
import type { Field } from '../fields';
import { t, tx } from '../i18n';
import { createQueryScope } from '../queryScope';
import { CancelledError } from '../net';
import { compileSearch } from '../queries';
import { VIEW } from '../sql';
import type { SearchState } from '../state';
import { Popover, fmtValue } from './ui';
import { loadHistory, rememberHistory } from '../history';

const LS_SQL = 'ddv.sql';
const LS_SQL_HISTORY = 'ddv.sqlHistory';
/** rows rendered before "Show all" */
const PAGE = 500;

function loadText(): string {
  try {
    return localStorage.getItem(LS_SQL) ?? `SELECT * FROM ${VIEW} LIMIT 100`;
  } catch {
    return `SELECT * FROM ${VIEW} LIMIT 100`;
  }
}

interface Result {
  columns: string[];
  rows: Row[];
  ms: number;
  sql: string;
}

/** The SQL page: one statement over the source view, its rows as a table, downloads of the result. */
export function SqlPage(props: { fields: Field[]; timeExpr: string | null; search: SearchState; onBusy: (b: boolean) => void; paused?: boolean }) {
  const [text, setText] = useState(loadText);
  const [history, setHistory] = useState(() => loadHistory(LS_SQL_HISTORY));
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const scope = useRef(createQueryScope()).current;
  useEffect(() => {
    if (props.paused) {
      scope.cancel();
      setBusy(false);
    }
    return () => scope.cancel();
  }, [scope, props.paused, props.fields]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_SQL, text);
    } catch {
      /* ignore */
    }
  }, [text]);

  const run = async () => {
    const sql = text.trim();
    if (!sql || busy || props.paused) return;
    const run = scope.start(props.onBusy);
    setBusy(true);
    setError(null);
    setShowAll(false);
    try {
      const r = await query(sql, run.signal);
      if (!run.isCurrent()) return;
      setResult({ columns: r.columns, rows: r.rows, ms: r.ms, sql });
      setHistory(rememberHistory(LS_SQL_HISTORY, sql, history));
    } catch (e) {
      if (run.isCurrent() && !(e instanceof CancelledError)) setError(describeError(e));
    } finally {
      if (run.isCurrent()) setBusy(false);
      run.finish();
    }
  };

  /** The Discover / Visualize search (query, filters, time range) as a statement to start from. */
  const insertSearch = () => {
    const c = compileSearch(props.search, props.fields, props.timeExpr);
    setText(`SELECT *\nFROM ${VIEW}\nWHERE ${c.where}\n${props.timeExpr ? `ORDER BY ${props.timeExpr} DESC\n` : ''}LIMIT 100`);
  };

  const download = async (format: ExportFormat) => {
    if (!result || busy || props.paused) return;
    try {
      downloadBlob(await exportToBlob(result.sql, format), exportFileName(format));
    } catch (e) {
      setError(describeError(e));
    }
  };

  const shown = result ? (showAll ? result.rows : result.rows.slice(0, PAGE)) : [];

  return (
    <div class="page sql-page">
      <div class="topbar">
        <textarea
          class="input sql-text"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void run();
            }
          }}
          spellcheck={false}
          rows={6}
        />
        <div class="row">
          <button class="btn primary" onClick={() => void run()} disabled={busy || props.paused}>
            {busy ? t('sql.running') : t('sql.run')}
          </button>
          {busy && (
            <button class="btn" onClick={() => void cancelAllQueries()}>
              {t('common.cancel')}
            </button>
          )}
          <button class="btn" onClick={insertSearch}>
            {t('sql.currentSearch')}
          </button>
          <Popover
            open={histOpen}
            onClose={() => setHistOpen(false)}
            width={560}
            button={
              <button class="btn" onClick={() => setHistOpen(!histOpen)}>
                {t('sql.history')}
              </button>
            }
          >
            <h4>{t('sql.history')}</h4>
            {history.length === 0 && <div class="hint">{t('sql.noHistory')}</div>}
            <div class="menu sql-history">
              {history.map((h) => (
                <button
                  key={h}
                  onClick={() => {
                    setText(h);
                    setHistOpen(false);
                  }}
                >
                  {h.length > 160 ? h.slice(0, 157) + '…' : h}
                </button>
              ))}
            </div>
          </Popover>
          <span class="hint">{tx('sql.hint', { view: <code>{VIEW}</code>, key: <kbd>Ctrl+Enter</kbd> })}</span>
        </div>
      </div>
      {busy && <div class="loading-bar" />}
      <div class="sql-result">
        {error && <div class="alert error">{error}</div>}
        {result && (
          <>
            <div class="row mb8">
              <span class="hint">{t('sql.rows', { n: result.rows.length.toLocaleString(), ms: Math.round(result.ms) })}</span>
              <span class="grow" />
              {EXPORT_FORMATS.map((f) => (
                <button key={f} class="btn small" disabled={busy || props.paused} onClick={() => void download(f)}>
                  {t(`exp.format.${f}`)}
                </button>
              ))}
            </div>
            <table class="data">
              <thead>
                <tr>
                  {result.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((row, i) => (
                  <tr key={i}>
                    {result.columns.map((c) => (
                      <td key={c} class={typeof row[c] === 'number' ? 'num' : ''}>
                        {fmtValue(row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!showAll && result.rows.length > PAGE && (
              <div class="load-more">
                <button class="btn" onClick={() => setShowAll(true)}>
                  {t('sql.showAll', { n: result.rows.length.toLocaleString() })}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
