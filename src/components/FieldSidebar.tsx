import { useEffect, useState } from 'preact/hooks';
import { t } from '../i18n';
import type { Field } from '../fields';
import { fetchTopValues, type TopValue } from '../queries';
import { FieldIcon } from './ui';

export function FieldSidebar(props: {
  fields: Field[];
  selected: string[];
  where: string;
  mode: 'discover' | 'visualize';
  onToggleColumn?: (name: string) => void;
  onAddFilter: (field: string, value: string | null, negate: boolean) => void;
  onVisualize?: (field: Field) => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  // where to place the details popover (position: fixed, so it floats above scrolling lists)
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [tops, setTops] = useState<{ values: TopValue[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [showTypes, setShowTypes] = useState(true);

  useEffect(() => {
    setTops(null);
    if (!open) return;
    const f = props.fields.find((x) => x.name === open);
    if (!f || f.kind === 'object') return;
    let alive = true;
    setLoading(true);
    fetchTopValues(props.where, f)
      .then((r) => alive && setTops(r))
      .catch(() => alive && setTops(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, props.where]);

  const visible = props.fields.filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase()));
  const selected = visible.filter((f) => props.selected.includes(f.name));
  const available = visible.filter((f) => !props.selected.includes(f.name));

  const renderItem = (f: Field) => {
    const isSel = props.selected.includes(f.name);
    return (
      <div
        class={'field-item' + (isSel ? ' selected' : '')}
        key={f.name}
        draggable={true}
        onDragStart={(e) => e.dataTransfer?.setData('text/field', f.name)}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setAnchor({ left: Math.min(r.right + 4, window.innerWidth - 336), top: Math.max(8, Math.min(r.top, window.innerHeight - 360)) });
          setOpen(open === f.name ? null : f.name);
        }}
      >
        {showTypes && <FieldIcon kind={f.kind} />}
        <span class="name" title={`${f.name} (${f.duckType})`}>
          {f.name}
        </span>
        {props.onToggleColumn && f.kind !== 'object' && (
          <button
            class="act"
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleColumn!(f.name);
            }}
          >
            {isSel ? t('fs.remove') : t('fs.add')}
          </button>
        )}
        {open === f.name && (
          <div class="field-details" style={anchor ? { left: anchor.left, top: anchor.top } : undefined} onClick={(e) => e.stopPropagation()}>
            <div class="row" style="justify-content:space-between;margin-bottom:6px">
              <b class="mono" style="font-size:12px">{f.name}</b>
              <span class="hint">{f.duckType}</span>
            </div>
            {f.kind === 'object' ? (
              <div class="hint">{t('fs.objectField')}</div>
            ) : (
              <>
                <h4>{t('fs.top5')}{tops ? t('fs.inRecords', { n: tops.total.toLocaleString() }) : ''}</h4>
                {loading && <div class="hint">{t('common.loading')}</div>}
                {tops &&
                  tops.values.map((v) => (
                    <div class="topval">
                      <div>
                        <div class="v mono" title={v.value ?? t('common.null')}>
                          {v.value === null ? <i>{t('common.null')}</i> : v.value === '' ? <i>{t('common.empty')}</i> : v.value}
                        </div>
                        <div class="bar">
                          <div style={{ width: `${Math.round(v.pct * 100)}%` }} />
                        </div>
                      </div>
                      <span class="hint">{(v.pct * 100).toFixed(1)}%</span>
                      <span class="pm">
                        <button title={t('doc.filterFor')} onClick={() => props.onAddFilter(f.name, v.value, false)}>
                          +
                        </button>
                        <button title={t('doc.filterOut')} onClick={() => props.onAddFilter(f.name, v.value, true)}>
                          −
                        </button>
                      </span>
                    </div>
                  ))}
                {tops && !tops.values.length && <div class="hint">{t('fs.noValues')}</div>}
              </>
            )}
            {props.onVisualize && f.kind !== 'object' && (
              <div class="row end" style="margin-top:8px">
                <button
                  class="btn small primary"
                  onClick={() => {
                    setOpen(null);
                    props.onVisualize!(f);
                  }}
                >
                  {t('fs.visualize')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div class="sidebar">
      <div class="search">
        <input placeholder={t('fs.search')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      <div class="list">
        {props.mode === 'discover' && selected.length > 0 && (
          <>
            <div class="group">
              <span>{t('fs.selected')}</span>
              <span>{selected.length}</span>
            </div>
            {selected.map(renderItem)}
          </>
        )}
        <div class="group">
          <span>{t('fs.available')}</span>
          <span>
            <button class="sql-toggle" onClick={() => setShowTypes(!showTypes)} title={t('fs.toggleTypes')}>
              {showTypes ? t('fs.types') : t('fs.typesOff')}
            </button>{' '}
            {available.length}
          </span>
        </div>
        {available.map(renderItem)}
      </div>
    </div>
  );
}
