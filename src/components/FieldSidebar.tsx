import { useEffect, useState } from 'preact/hooks';
import { t } from '../i18n';
import type { Field } from '../fields';
import { fetchNumberStats, fetchTopValues, type NumberStats, type TopValue } from '../queries';
import { FieldIcon, fmtNum } from './ui';

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
  const [stats, setStats] = useState<NumberStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [showTypes, setShowTypes] = useState(true);

  useEffect(() => {
    setTops(null);
    setStats(null);
    if (!open) return;
    const f = props.fields.find((x) => x.name === open);
    if (!f || f.kind === 'object') return;
    let alive = true;
    setLoading(true);
    // numbers get a summary and a small distribution on top of their most frequent values
    Promise.all([fetchTopValues(props.where, f), f.kind === 'number' ? fetchNumberStats(props.where, f) : Promise.resolve(null)])
      .then(([r, st]) => {
        if (!alive) return;
        setTops(r);
        setStats(st);
      })
      .catch(() => alive && setTops(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, props.where, props.fields]);

  // the details popover closes on a click anywhere else (a click on a field item is handled by the item itself)
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (el?.closest('.field-details') || el?.closest('.field-item')) return;
      setOpen(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const visible = props.fields.filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase()));
  const selected = visible.filter((f) => props.selected.includes(f.name));
  const available = visible.filter((f) => !props.selected.includes(f.name));

  /** Open (or close) the details popover next to the item that was clicked or activated from the keyboard. */
  const toggleDetails = (f: Field, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAnchor({ left: Math.min(r.right + 4, window.innerWidth - 336), top: Math.max(8, Math.min(r.top, window.innerHeight - 360)) });
    setOpen(open === f.name ? null : f.name);
  };

  const renderItem = (f: Field) => {
    const isSel = props.selected.includes(f.name);
    return (
      <div
        class={'field-item' + (isSel ? ' selected' : '')}
        key={f.name}
        role="button"
        tabIndex={0}
        aria-expanded={open === f.name}
        draggable={true}
        onDragStart={(e) => e.dataTransfer?.setData('text/field', f.name)}
        onClick={(e) => toggleDetails(f, e.currentTarget as HTMLElement)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleDetails(f, e.currentTarget as HTMLElement);
          } else if (e.key === 'Escape' && open === f.name) setOpen(null);
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
              <b class="mono" style="font-size:12px">
                {f.name}
              </b>
              <span class="hint">{f.duckType}</span>
            </div>
            {f.kind === 'object' ? (
              <div class="hint">{t('fs.objectField')}</div>
            ) : (
              <>
                {stats && (
                  <>
                    <h4>{t('fs.stats')}</h4>
                    <div class="stat-grid">
                      {(
                        [
                          [t('vis.agg.min'), stats.min],
                          [t('vis.agg.max'), stats.max],
                          [t('vis.agg.avg'), stats.avg],
                          [t('vis.agg.median'), stats.p50],
                          [t('vis.agg.p95'), stats.p95],
                        ] as [string, number][]
                      ).map(([k, v]) => (
                        <span key={k}>
                          <span class="hint">{k}</span> <b class="mono">{fmtNum(v)}</b>
                        </span>
                      ))}
                    </div>
                    <div class="dist" title={t('fs.dist', { from: fmtNum(stats.min), to: fmtNum(stats.max) })}>
                      {stats.bins.map((c, i) => (
                        <div
                          key={i}
                          style={{ height: `${Math.max(2, Math.round((c / Math.max(1, ...stats.bins)) * 100))}%` }}
                          title={`${fmtNum(stats.min + i * stats.width)} – ${fmtNum(stats.min + (i + 1) * stats.width)}: ${c.toLocaleString()}`}
                        />
                      ))}
                    </div>
                  </>
                )}
                <h4>
                  {t('fs.top5')}
                  {tops ? t('fs.inRecords', { n: tops.total.toLocaleString() }) : ''}
                </h4>
                {loading && <div class="hint">{t('common.loading')}</div>}
                {tops &&
                  tops.values.map((v) => (
                    <div key={v.value ?? ''} class="topval">
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
                        <button title={t('doc.filterFor')} aria-label={t('doc.filterFor')} onClick={() => props.onAddFilter(f.name, v.value, false)}>
                          +
                        </button>
                        <button title={t('doc.filterOut')} aria-label={t('doc.filterOut')} onClick={() => props.onAddFilter(f.name, v.value, true)}>
                          −
                        </button>
                      </span>
                    </div>
                  ))}
                {tops && !tops.values.length && <div class="hint">{t('fs.noValues')}</div>}
              </>
            )}
            {props.onVisualize && f.kind !== 'object' && (
              <div class="row end mt8">
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
        <input placeholder={t('fs.search')} value={q} onInput={(e) => setQ(e.currentTarget.value)} />
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
