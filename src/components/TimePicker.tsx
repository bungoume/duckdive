import { useState } from 'preact/hooks';
import { Popover } from './ui';
import { QUICK_RANGES, describeRange, resolveRange, toDatetimeLocal, type TimeRange } from '../datemath';

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
          <button class="btn" onClick={openPicker} title={resolved ? `${resolved.from.toLocaleString()} → ${resolved.to.toLocaleString()}` : ''}>
            <span>◷</span> {describeRange(props.range)} <span style="color:#98a2b3">▾</span>
          </button>
        }
      >
        <div class="tp-body">
          <h4>Quick select</h4>
          <div class="row" style="margin-bottom:10px">
            <span>Last</span>
            <input class="input" type="number" min={1} value={n} style="width:80px" onInput={(e) => setN(Number((e.target as HTMLInputElement).value))} />
            <select class="input" style="width:120px" value={unit} onChange={(e) => setUnit((e.target as HTMLSelectElement).value)}>
              <option value="s">seconds</option>
              <option value="m">minutes</option>
              <option value="h">hours</option>
              <option value="d">days</option>
              <option value="w">weeks</option>
              <option value="M">months</option>
              <option value="y">years</option>
            </select>
            <button
              class="btn primary small"
              onClick={() => {
                props.onChange({ from: `now-${n}${unit}`, to: 'now' });
                setOpen(false);
              }}
            >
              Apply
            </button>
          </div>
          <div class="tp-cols">
            <div class="col">
              <h4>Commonly used</h4>
              <div class="quick-grid">
                {QUICK_RANGES.map((q) => (
                  <button
                    onClick={() => {
                      props.onChange({ from: q.from, to: q.to });
                      setOpen(false);
                    }}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
            <div class="col">
              <h4>Absolute</h4>
              <div class="field-row">
                <label>Start</label>
                <input class="input" type="datetime-local" step={1} value={absFrom} onInput={(e) => setAbsFrom((e.target as HTMLInputElement).value)} />
              </div>
              <div class="field-row">
                <label>End</label>
                <input class="input" type="datetime-local" step={1} value={absTo} onInput={(e) => setAbsTo((e.target as HTMLInputElement).value)} />
              </div>
              <div class="row end">
                <button
                  class="btn small"
                  onClick={() => {
                    const f = new Date(absFrom);
                    const t = new Date(absTo);
                    if (isNaN(f.getTime()) || isNaN(t.getTime())) return;
                    props.onChange({ from: f.toISOString(), to: t.toISOString() });
                    setOpen(false);
                  }}
                >
                  Update
                </button>
              </div>
            </div>
          </div>
        </div>
      </Popover>
      <button class="btn" title="Previous time window" onClick={() => shift(-1)}>
        ‹
      </button>
      <button class="btn" title="Next time window" onClick={() => shift(1)}>
        ›
      </button>
    </div>
  );
}
