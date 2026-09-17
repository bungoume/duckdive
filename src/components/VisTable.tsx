// The table and the metric tiles of the Visualize page: the non-graphical renderings of a VisResult.
import { useState } from 'preact/hooks';
import { formatBucket, formatDate } from '../datefmt';
import { downloadBlob } from '../export';
import { t } from '../i18n';
import { NULL_GROUP, groupLabel, metricLabel, type VisResult } from '../queries';
import type { MetricDef } from '../state';
import { fmtNum } from './ui';

const NL = String.fromCharCode(10);

export function DataTable(props: { result: VisResult; metrics: MetricDef[]; xLabel: string; gLabel: string | null }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const r = props.result;
  const hasX = r.xKind !== 'none';
  const hasG = !!props.gLabel;
  const isDate = r.xKind === 'date_histogram';
  const headers: string[] = [];
  if (hasX) headers.push(props.xLabel);
  if (hasG) headers.push(props.gLabel!);
  headers.push(...props.metrics.map(metricLabel));
  let rows = r.rows.map((row) => {
    const cells: (string | number)[] = [];
    if (hasX) cells.push(row.x === null ? t('common.null') : isDate ? (row.x as number) : groupLabel(String(row.x)));
    if (hasG) cells.push(groupLabel(row.g ?? NULL_GROUP));
    cells.push(...row.m);
    return cells;
  });
  if (hasX && r.xKind === 'terms') {
    const order = new Map(r.xOrder.map((x, i) => [String(x), i]));
    rows.sort((a, b) => (order.get(String(a[0])) ?? 0) - (order.get(String(b[0])) ?? 0));
  }
  if (sort) {
    rows = [...rows].sort((a, b) => {
      const x = a[sort.col];
      const y = b[sort.col];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sort.dir;
      return String(x).localeCompare(String(y)) * sort.dir;
    });
  }
  const isDateCell = (i: number) => hasX && i === 0 && isDate;
  const csv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.map(esc).join(',')];
    for (const row of rows) lines.push(row.map((c, i) => esc(isDateCell(i) && typeof c === 'number' ? new Date(c).toISOString() : c)).join(','));
    downloadBlob(new Blob([lines.join(NL)], { type: 'text/csv' }), 'duckdive-table.csv');
  };
  return (
    <div>
      <div class="row" style="justify-content:space-between;margin-bottom:6px">
        <span class="hint">{t('chart.rows', { n: rows.length.toLocaleString() })}</span>
        <button class="btn small" onClick={csv}>
          {t('chart.downloadCsv')}
        </button>
      </div>
      <div style="overflow:auto;max-height:70vh">
        <table class="data">
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th onClick={() => setSort(sort && sort.col === i ? { col: i, dir: sort.dir === 1 ? -1 : 1 } : { col: i, dir: 1 })}>
                  {h}
                  {sort?.col === i ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr>
                {row.map((c, i) => {
                  if (isDateCell(i) && typeof c === 'number') return <td>{r.interval ? formatBucket(new Date(c), r.interval.ms) : formatDate(new Date(c))}</td>;
                  const isNum = typeof c === 'number';
                  return <td class={isNum ? 'num' : ''}>{isNum ? fmtNum(c) : String(c)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function MetricTiles(props: { result: VisResult; metrics: MetricDef[] }) {
  const r = props.result;
  const rows = r.rows.length ? r.rows : [{ x: null, g: null, m: props.metrics.map(() => NaN) }];
  return (
    <div style="display:flex;flex-wrap:wrap;gap:16px;flex:1;align-content:center;justify-content:center">
      {rows.slice(0, 12).map((row) =>
        props.metrics.map((m, i) => (
          <div class="metric-big" style="min-width:200px;padding:16px">
            <div class="val">{fmtNum(row.m[i])}</div>
            <div class="lbl">
              {row.g ? `${groupLabel(row.g)} · ` : ''}
              {metricLabel(m)}
            </div>
          </div>
        )),
      )}
    </div>
  );
}
