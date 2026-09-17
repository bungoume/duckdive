import { useState } from 'preact/hooks';
import { t } from '../i18n';
import { formatLocal } from '../datemath';
import { findField } from '../fields';
import type { Field } from '../fields';
import type { Doc } from '../queries';
import type { SortDir } from '../state';
import { ContextView } from './ContextView';
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

function DocDetail(props: {
  doc: Doc;
  fields: Field[];
  columns: string[];
  timeExpr: string | null;
  timeFieldName: string | null;
  onFilter: (field: string, value: string | null, negate: boolean) => void;
  onExists: (field: string) => void;
  onToggleColumn: (name: string) => void;
}) {
  const [tab, setTab] = useState<'table' | 'json' | 'context'>('table');
  const [copied, setCopied] = useState(false);
  const entries = flatten(props.doc.source);
  const known = new Set(props.fields.map((f) => f.name));
  const canContext = props.doc.ts !== null && !!props.timeExpr;
  const json = JSON.stringify(props.doc.source, null, 2);
  const copy = () => {
    navigator.clipboard
      .writeText(json)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  return (
    <div class="doc-detail">
      <div class="tabs">
        <button class={tab === 'table' ? 'active' : ''} onClick={() => setTab('table')}>
          {t('doc.table')}
        </button>
        <button class={tab === 'json' ? 'active' : ''} onClick={() => setTab('json')}>
          {t('doc.json')}
        </button>
        {canContext && (
          <button class={tab === 'context' ? 'active' : ''} onClick={() => setTab('context')}>
            {t('doc.context')}
          </button>
        )}
      </div>
      {tab === 'context' && canContext ? (
        <ContextView ts={props.doc.ts!} fields={props.fields} timeExpr={props.timeExpr!} timeFieldName={props.timeFieldName} />
      ) : tab === 'json' ? (
        <div class="json-view">
          <button class="btn small copy" onClick={copy}>
            {copied ? t('doc.copied') : t('doc.copyJson')}
          </button>
          <pre>{json}</pre>
        </div>
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
                        <button title={t('doc.filterFor')} aria-label={t('doc.filterFor')} onClick={() => props.onFilter(k, val, false)}>
                          +
                        </button>
                        <button title={t('doc.filterOut')} aria-label={t('doc.filterOut')} onClick={() => props.onFilter(k, val, true)}>
                          −
                        </button>
                        <button title={t('doc.toggleColumn')} aria-label={t('doc.toggleColumn')} onClick={() => props.onToggleColumn(k)}>
                          ⊞
                        </button>
                        <button title={t('doc.filterExists')} aria-label={t('doc.filterExists')} onClick={() => props.onExists(k)}>
                          *
                        </button>
                      </>
                    )}
                  </td>
                  <td class="k">{k}</td>
                  <td class="v" title={val ?? ''}>
                    {shown === null ? <i class="subdued">null</i> : shown}
                  </td>
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
  /** SQL of the time field (the Context tab needs it); null without a time field */
  timeExpr: string | null;
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
    if (s.has(i)) s.delete(i);
    else s.add(i);
    setOpen(s);
  };
  const sortIcon = (name: string) => {
    const s = props.sort.find((x) => x.field === name);
    return s ? (s.dir === 'asc' ? ' ▲' : ' ▼') : '';
  };
  const cols = props.columns;
  const colSpan = 2 + (cols.length || 1);
  const known = new Set(props.fields.map((f) => f.name));
  const asValue = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <table class="docs">
      <thead>
        <tr>
          <th></th>
          {props.hasTime && (
            <th onClick={() => props.timeFieldName && props.onSort(props.timeFieldName)}>
              {t('doc.time')}
              {props.timeFieldName ? sortIcon(props.timeFieldName) : ''}
            </th>
          )}
          {cols.length === 0 ? (
            <th>{t('doc.document')}</th>
          ) : (
            cols.map((c) => (
              <th onClick={() => props.onSort(c)}>
                {c}
                {sortIcon(c)}
                <button
                  class="rm"
                  title={t('doc.removeColumn')}
                  aria-label={t('doc.removeColumn')}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onRemoveColumn(c);
                  }}
                >
                  ✕
                </button>
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
                <button onClick={() => toggle(i)} title={t('doc.toggleDetails')} aria-label={t('doc.toggleDetails')} aria-expanded={open.has(i)}>
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
                        <span class="sv" key={k}>
                          <span class="k">{k}: </span>
                          <span class="v">{fmtValue(v)}</span>
                          {known.has(k) && (
                            <span class="pm">
                              <button title={t('doc.filterFor')} aria-label={t('doc.filterFor')} onClick={() => props.onFilter(k, asValue(v), false)}>
                                +
                              </button>
                              <button title={t('doc.filterOut')} aria-label={t('doc.filterOut')} onClick={() => props.onFilter(k, asValue(v), true)}>
                                −
                              </button>
                            </span>
                          )}
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
                  <DocDetail
                    doc={d}
                    fields={props.fields}
                    columns={cols}
                    timeExpr={props.timeExpr}
                    timeFieldName={props.timeFieldName}
                    onFilter={props.onFilter}
                    onExists={props.onExists}
                    onToggleColumn={props.onToggleColumn}
                  />
                </td>
              </tr>
            )}
          </>
        ))}
      </tbody>
    </table>
  );
}
