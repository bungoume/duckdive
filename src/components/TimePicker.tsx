import { useState } from 'preact/hooks';
import { Popover } from './ui';
import { describeRange, fromDatetimeLocal, quickRangeLabel, quickRanges, resolveRange, toDatetimeLocal, type TimeRange } from '../datemath';
import { formatDate } from '../datefmt';
import { t } from '../i18n';

export function TimePicker(props: { range: TimeRange; onChange: (r: TimeRange) => void }) {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(15);
  const [unit, setUnit] = useState('m');
  const resolved = resolveRange(props.range);
  const [absFrom, setAbsFrom] = useState(resolved ? toDatetimeLocal(resolved.from) : '');
  const [absTo, setAbsTo] = useState(resolved ? toDatetimeLocal(resolved.to) : '');

  const shift = (dir: -1 | 1) => {
    const r = resolveRange(props.range);
    if (!r) return;
    const span = r.to.getTime() - r.from.getTime();
    const from = new Date(r.from.getTime() + dir * span);
    const to = new Date(r.to.getTime() + dir * span);
    props.onChange({ from: from.toISOString(), to: to.toISOString() });
  };

  const openPicker = () => {
    const r = resolveRange(props.range);
    if (r) {
      setAbsFrom(toDatetimeLocal(r.from));
      setAbsTo(toDatetimeLocal(r.to));
    }
    setOpen(!open);
  };

  return (
    <div class="timepicker">
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        align="right"
        button={
          <button class="btn" onClick={openPicker} title={resolved ? `${formatDate(resolved.from)} → ${formatDate(resolved.to)}` : ''}>
            <span aria-hidden="true">◷</span> {describeRange(props.range)}{' '}
            <span class="subdued" aria-hidden="true">
              ▾
            </span>
          </button>
        }
      >
        <div class="tp-body">
          <h4>{t('tp.quick')}</h4>
          <div class="row" style="margin-bottom:10px">
            <span>{t('tp.last')}</span>
            <input class="input" type="number" min={1} value={n} style="width:80px" onInput={(e) => setN(Number((e.target as HTMLInputElement).value))} />
            <select class="input" style="width:120px" value={unit} onChange={(e) => setUnit((e.target as HTMLSelectElement).value)}>
              <option value="s">{t('tp.unit.s')}</option>
              <option value="m">{t('tp.unit.m')}</option>
              <option value="h">{t('tp.unit.h')}</option>
              <option value="d">{t('tp.unit.d')}</option>
              <option value="w">{t('tp.unit.w')}</option>
              <option value="M">{t('tp.unit.M')}</option>
              <option value="y">{t('tp.unit.y')}</option>
            </select>
            <button
              class="btn primary small"
              onClick={() => {
                props.onChange({ from: `now-${n}${unit}`, to: 'now' });
                setOpen(false);
              }}
            >
              {t('tp.apply')}
            </button>
          </div>
          <div class="tp-cols">
            <div class="col">
              <h4>{t('tp.common')}</h4>
              <div class="quick-grid">
                {quickRanges().map((q) => (
                  <button
                    onClick={() => {
                      props.onChange({ from: q.from, to: q.to });
                      setOpen(false);
                    }}
                  >
                    {quickRangeLabel(q)}
                  </button>
                ))}
              </div>
            </div>
            <div class="col">
              <h4>{t('tp.absolute')}</h4>
              <div class="field-row">
                <label>{t('tp.start')}</label>
                <input class="input" type="datetime-local" step={1} value={absFrom} onInput={(e) => setAbsFrom((e.target as HTMLInputElement).value)} />
              </div>
              <div class="field-row">
                <label>{t('tp.end')}</label>
                <input class="input" type="datetime-local" step={1} value={absTo} onInput={(e) => setAbsTo((e.target as HTMLInputElement).value)} />
              </div>
              <div class="row end">
                <button
                  class="btn small"
                  onClick={() => {
                    const f = fromDatetimeLocal(absFrom);
                    const t = fromDatetimeLocal(absTo);
                    if (!f || !t) return;
                    props.onChange({ from: f.toISOString(), to: t.toISOString() });
                    setOpen(false);
                  }}
                >
                  {t('tp.update')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Popover>
      <button class="btn" title={t('tp.prev')} onClick={() => shift(-1)}>
        ‹
      </button>
      <button class="btn" title={t('tp.next')} onClick={() => shift(1)}>
        ›
      </button>
    </div>
  );
}
