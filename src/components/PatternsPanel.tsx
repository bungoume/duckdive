import { useEffect, useState } from 'preact/hooks';
import { describeError } from '../errors';
import type { Field } from '../fields';
import { t } from '../i18n';
import { CancelledError } from '../net';
import { templateFilterSql } from '../patterns';
import { fetchPatterns, type LogPattern } from '../queries';
import { newId, type Filter } from '../sql';
import { trustSql } from '../trust';

/** The text field worth analysing first: message-like names, else the first string field. */
export function defaultPatternField(fields: Field[]): Field | null {
  const strings = fields.filter((f) => f.kind === 'string');
  return strings.find((f) => /(^|\.)(message|msg|log|line|text|raw|request)$/i.test(f.name)) ?? strings[0] ?? null;
}

/** Discover's "Patterns": the templates of a text field in the current search, most frequent first. */
export function PatternsPanel(props: { fields: Field[]; where: string; field: Field | null; onField: (name: string) => void; onFilter: (f: Filter) => void; refreshTick?: number }) {
  const { field, where, refreshTick } = props;
  const [result, setResult] = useState<{ patterns: LogPattern[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setResult(null);
    setError(null);
    if (!field) return;
    let alive = true;
    setLoading(true);
    fetchPatterns(where, field)
      .then((r) => alive && setResult(r))
      .catch((e) => alive && !(e instanceof CancelledError) && setError(describeError(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [field, where, refreshTick]);

  const filterFor = (p: LogPattern) => {
    if (!field) return;
    const sql = templateFilterSql(field.expr, p.tpl);
    trustSql(sql);
    props.onFilter({ id: newId(), field: '', op: 'query', sql, label: p.tpl });
  };

  return (
    <div class="patterns">
      <div class="row mb8">
        <b>{t('pat.title')}</b>
        <select class="input chart-select" value={field?.name ?? ''} onChange={(e) => props.onField(e.currentTarget.value)} aria-label={t('common.field')}>
          {props.fields
            .filter((f) => f.kind === 'string')
            .map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
        </select>
        <span class="hint">{result ? t('pat.showing', { n: result.patterns.length, total: result.total.toLocaleString() }) : loading ? t('common.loading') : ''}</span>
      </div>
      <p class="hint">{t('pat.hint')}</p>
      {!field && <div class="hint">{t('pat.none')}</div>}
      {error && <div class="alert error">{error}</div>}
      {result && (
        <table class="data patterns-table">
          <thead>
            <tr>
              <th class="num">{t('pat.count')}</th>
              <th></th>
              <th>{t('pat.pattern')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {result.patterns.map((p) => (
              <tr key={p.tpl}>
                <td class="num">{p.count.toLocaleString()}</td>
                <td class="num hint">{(p.pct * 100).toFixed(1)}%</td>
                <td>
                  <div class="mono tpl">{p.tpl}</div>
                  <div class="hint mono example">{p.example}</div>
                </td>
                <td>
                  <button class="btn small" onClick={() => filterFor(p)} title={t('pat.filter')}>
                    +
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
