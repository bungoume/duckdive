import * as Plot from '@observablehq/plot';
import { t, useLang } from '../i18n';
import { formatBucket } from '../datefmt';
import { useSettings } from '../settings';
import { timeAxis } from '../ticks';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bucket } from '../queries';
import type { Interval } from '../sql';

/** Fill empty buckets so the bar chart has a continuous x axis. */
export function fillBuckets(b: Bucket[], from: Date, to: Date, iv: Interval): Bucket[] {
  if (!b.length || iv.ms >= 30 * 86400000) return b;
  const map = new Map(b.map((x) => [x.t, x.c]));
  const start = b[0].t;
  const out: Bucket[] = [];
  for (let t = start; t <= to.getTime() && out.length < 5000; t += iv.ms) out.push({ t, c: map.get(t) ?? 0 });
  return out;
}

export function Histogram(props: { buckets: Bucket[]; interval: Interval; from: Date; to: Date; height?: number; onBrush: (from: Date, to: Date) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [brush, setBrush] = useState<{ x0: number; x1: number } | null>(null);
  const drag = useRef<{ start: number; svg: SVGSVGElement; plot: any } | null>(null);
  const [width, setWidth] = useState(800);
  // the axis label is baked into the plot: rebuild it when the language changes
  const lang = useLang();
  const settings = useSettings();

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((es) => setWidth(Math.max(300, Math.floor(es[0].contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const data = props.buckets.map((b) => ({ t: new Date(b.t), t2: new Date(b.t + props.interval.ms), c: b.c }));
    const marginLeft = 50;
    const marginRight = 20;
    const axis = timeAxis(props.from, props.to, width - marginLeft - marginRight, props.interval.ms);
    const plot = Plot.plot({
      width,
      height: props.height ?? 160,
      marginLeft,
      marginRight,
      marginBottom: 28,
      style: { fontSize: '11px', background: 'transparent', overflow: 'visible' },
      x: { type: 'time', domain: [props.from, props.to], label: null, grid: false, ticks: axis.ticks, tickFormat: axis.tickFormat },
      y: { label: t('hist.count'), grid: true, nice: true, tickFormat: (d: number) => (d >= 1000 ? `${(d / 1000).toFixed(d >= 10000 ? 0 : 1)}k` : String(d)) },
      marks: [
        Plot.rectY(data, { x1: 't', x2: 't2', y: 'c', fill: '#54b399', inset: 1, insetLeft: 0.5, insetRight: 0.5 }),
        Plot.ruleY([0]),
        Plot.tip(
          data,
          Plot.pointerX({
            x: 't',
            y: 'c',
            title: (d: any) => `${formatBucket(d.t, props.interval.ms)}\n${t('hist.records', { n: d.c.toLocaleString() })}`,
          }),
        ),
      ],
    });
    // Plot renders in UTC for type 'utc'; shift to local time display by using local scale instead
    el.replaceChildren(plot);
    return () => plot.remove();
  }, [props.buckets, props.interval, props.from, props.to, width, lang, settings]);

  const onDown = (e: PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const svg = el.querySelector('svg');
    if (!svg) return;
    const rect = el.getBoundingClientRect();
    drag.current = { start: e.clientX - rect.left, svg, plot: el.firstElementChild };
    setBrush({ x0: e.clientX - rect.left, x1: e.clientX - rect.left });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag.current || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setBrush({ x0: drag.current.start, x1: e.clientX - rect.left });
  };
  const onUp = (e: PointerEvent) => {
    if (!drag.current || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const a = drag.current.start;
    const b = e.clientX - rect.left;
    const plot = drag.current.plot as any;
    drag.current = null;
    setBrush(null);
    if (Math.abs(a - b) < 4) return;
    const svgEl = ref.current.querySelector('svg')!;
    const svgRect = svgEl.getBoundingClientRect();
    const off = svgRect.left - rect.left;
    const kx = svgEl.width.baseVal.value / (svgRect.width || 1);
    const xs = plot?.scale?.('x');
    if (!xs || !xs.invert) return;
    const d0 = xs.invert((Math.min(a, b) - off) * kx) as Date;
    const d1 = xs.invert((Math.max(a, b) - off) * kx) as Date;
    if (d0 instanceof Date && d1 instanceof Date && !isNaN(d0.getTime())) props.onBrush(d0, d1);
  };

  return (
    <div class="chart-box" onPointerDownCapture={onDown} onPointerMove={onMove} onPointerUp={onUp} style="cursor:crosshair">
      <div ref={ref} />
      {brush && <div class="brush" style={{ left: Math.min(brush.x0, brush.x1), width: Math.abs(brush.x1 - brush.x0) }} />}
    </div>
  );
}
