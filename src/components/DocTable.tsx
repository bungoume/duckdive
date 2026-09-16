import { useState } from 'preact/hooks';
import { t } from '../i18n';
import { formatLocal } from '../datemath';
import { findField } from '../fields';
import type { Field } from '../fields';
import type { Doc } from '../queries';
import type { SortDir } from '../state';
import { fmtValue } from './ui';

export function flatten(o: unknown, prefix = '', out: [string, unknown][] = []): [string, unknown][] {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
      else out.push([key, v]);
    }
  }
  return out;
}

function DocDetail(props: { doc: Doc; fields: Field[]; columns: string[]; onFilter: (field: string, value: string | null, negate: boolean) => void; onExists: (field: string) => void; onToggleColumn: (name: string) => void }) {
  const [tab, setTab] = useState<'table' | 'json'>('table');
  const entries = flatten(props.doc.source);
  const known = new Set(props.fields.map((f) => f.name));
  return (
    <div class="doc-detail">
      <div class="tabs">
        <button class={tab === 'table' ? 'active' : ''} onClick={() => setTab('table')}>
          {t('doc.table')}
        </button>
        <button class={tab === 'json' ? 'active' : ''} onClick={() => setTab('json')}>
          {t('doc.json')}
        </button>
      </div>
      {tab === 'json' ? (
        <pre>{JSON.stringify(props.doc.source, null, 2)}</pre>
      ) : (
        <table class="kv">
          <tbody>
          {entries.map(([k, v]) => {
            const filterable = known.has(k);
            const val = v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);
            const fld = findField(props.fields, k);
            let shown = val;
            if (val !== null && fld?.kind === 'date') {
              const d = new Date(val.includes('T') || /[zZ]|[+-]\d\d:?\d\d$/.test(val) ? val : val.replace(' ', 'T') + 'Z');
              if (!isNaN(d.getTime())) shown = formatLocal(d);
            }
            return (
              <tr>
                <td class="a">
                  {filterable && (
                    <>
                      <button title={t('doc.filterFor')} onClick={() => props.onFilter(k, val, false)}>+</button>
                      <button title={t('doc.filterOut')} onClick={() => props.onFilter(k, val, true)}>−</button>
                      <button title={t('doc.toggleColumn')} onClick={() => props.onToggleColumn(k)}>⊞</button>
                      <button title={t('doc.filterExists')} onClick={() => props.onExists(k)}>*</button>
                    </>
                  )}
                </td>
                <td class="k">{k}</td>
                <td class="v" title={val ?? ''}>{shown === null ? <i style="color:#98a2b3">null</i> : shown}</td>
              </tr>
            );
          })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function DocTable(props: {
  docs: Doc[];
  fields: Field[];
  columns: string[];
  hasTime: boolean;
  timeFieldName: string | null;
  sort: { field: string; dir: SortDir }[];
  onSort: (field: string) => void;
  onRemoveColumn: (name: string) => void;
  onToggleColumn: (name: string) => void;
  onFilter: (field: string, value: string | null, negate: boolean) => void;
  onExists: (field: string) => void;
}) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (i: number) => {
    const s = new Set(open);
    s.has(i) ? s.delete(i) : s.add(i);
    setOpen(s);
  };
  const sortIcon = (name: string) => {
    const s = props.sort.find((x) => x.field === name);
    return s ? (s.dir === 'asc' ? ' ▲' : ' ▼') : '';
  };
  const cols = props.columns;
  const colSpan = 2 + (cols.length || 1);
  return (
    <table class="docs">
      <thead>
        <tr>
          <th></th>
          {props.hasTime && (
            <th onClick={() => props.timeFieldName && props.onSort(props.timeFieldName)}>{t('doc.time')}{props.timeFieldName ? sortIcon(props.timeFieldName) : ''}</th>
          )}
          {cols.length === 0 ? (
            <th>{t('doc.document')}</th>
          ) : (
            cols.map((c) => (
              <th onClick={() => props.onSort(c)}>
                {c}
                {sortIcon(c)}
                <span
                  class="rm"
                  title={t('doc.removeColumn')}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onRemoveColumn(c);
                  }}
                >
                  ✕
                </span>
              </th>
            ))
          )}
        </tr>
      </thead>
      <tbody>
        {props.docs.map((d, i) => (
          <>
            <tr key={i}>
              <td class="expand">
                <button onClick={() => toggle(i)} title={t('doc.toggleDetails')}>
                  {open.has(i) ? '▼' : '▶'}
                </button>
              </td>
              {props.hasTime && <td class="time">{d.ts === null ? '–' : formatLocal(new Date(d.ts))}</td>}
              {cols.length === 0 ? (
                <td>
                  <div class="source-summary">
                    {flatten(d.source)
                      .filter(([k]) => k !== props.timeFieldName)
                      .slice(0, 40)
                      .map(([k, v]) => (
                        <span>
                          <span class="k">{k}: </span>
                          <span class="v">{fmtValue(v)}</span>
                        </span>
                      ))}
                  </div>
                </td>
              ) : (
                cols.map((c) => <td class="cell">{fmtValue(d.cols[c])}</td>)
              )}
            </tr>
            {open.has(i) && (
              <tr>
                <td colSpan={colSpan + (props.hasTime ? 0 : -1)}>
                  <DocDetail doc={d} fields={props.fields} columns={cols} onFilter={props.onFilter} onExists={props.onExists} onToggleColumn={props.onToggleColumn} />
                </td>
              </tr>
            )}
          </>
        ))}
      </tbody>
    </table>
  );
}
