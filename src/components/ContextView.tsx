import { useEffect, useState } from 'preact/hooks';
import { formatLocal } from '../datemath';
import { describeError } from '../errors';
import type { Field } from '../fields';
import { t } from '../i18n';
import { CancelledError } from '../net';
import { fetchDocs, type Doc } from '../queries';
import { tsLit } from '../sql';
import { flatten } from './DocTable';
import { fmtValue } from './ui';

const STEP = 5;

/** The records around one in time, whatever the query and filters: some before, those at the same time, some after. */
export function ContextView(props: { ts: number; fields: Field[]; timeExpr: string; timeFieldName: string | null }) {
  const [before, setBefore] = useState(STEP);
  const [after, setAfter] = useState(STEP);
  const [rows, setRows] = useState<{ before: Doc[]; same: Doc[]; after: Doc[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { ts, fields, timeExpr } = props;

  useEffect(() => {
    let alive = true;
    // the row's time is known to the millisecond: "same time" is that millisecond
    const at = tsLit(new Date(ts));
    const next = tsLit(new Date(ts + 1));
    Promise.all([
      fetchDocs(`${timeExpr} < ${at}`, timeExpr, fields, [], [], before, 0, 'desc'),
      fetchDocs(`${timeExpr} >= ${at} AND ${timeExpr} < ${next}`, timeExpr, fields, [], [], 50, 0, 'asc'),
      fetchDocs(`${timeExpr} >= ${next}`, timeExpr, fields, [], [], after, 0, 'asc'),
    ])
      .then(([b, s, a]) => alive && setRows({ before: [...b.docs].reverse(), same: s.docs, after: a.docs }))
      .catch((e) => alive && !(e instanceof CancelledError) && setError(describeError(e)));
    return () => {
      alive = false;
    };
  }, [ts, timeExpr, fields, before, after]);

  const row = (d: Doc, cls: string, i: number) => (
    <tr key={`${cls}${i}`} class={cls}>
      <td class="time">{d.ts === null ? '–' : formatLocal(new Date(d.ts))}</td>
      <td>
        <div class="source-summary">
          {flatten(d.source)
            .filter(([k]) => k !== props.timeFieldName)
            .slice(0, 40)
            .map(([k, v]) => (
              <span key={k}>
                <span class="k">{k}: </span>
                <span class="v">{fmtValue(v)}</span>
              </span>
            ))}
        </div>
      </td>
    </tr>
  );

  return (
    <div class="context-view">
      <p class="hint">{t('doc.context.hint')}</p>
      {error && <div class="alert error">{error}</div>}
      {rows && (
        <>
          <button class="btn small" onClick={() => setBefore(before + STEP)}>
            {t('doc.context.more', { n: STEP })}
          </button>
          <table class="docs">
            <tbody>
              {rows.before.map((d, i) => row(d, 'before', i))}
              {rows.same.map((d, i) => row(d, 'same', i))}
              {rows.after.map((d, i) => row(d, 'after', i))}
            </tbody>
          </table>
          <button class="btn small" onClick={() => setAfter(after + STEP)}>
            {t('doc.context.more', { n: STEP })}
          </button>
        </>
      )}
      {!rows && !error && <div class="hint">{t('common.loading')}</div>}
    </div>
  );
}
