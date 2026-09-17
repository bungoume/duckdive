import * as Plot from '@observablehq/plot';
import { t, useLang } from '../i18n';
import { formatBucket } from '../datefmt';
import { useSettings } from '../settings';
import { timeAxis } from '../ticks';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bucket } from '../queries';
import { bucketStarts, nextBucketStart, type Interval } from '../sql';
import { fmtAxisNumber } from './ui';

/** Fill empty buckets (from the first one up to `to`) so the bar chart has a continuous x axis. */
export function fillBuckets(b: Bucket[], to: Date, iv: Interval, tzOffset: number): Bucket[] {
  if (!b.length) return b;
  const map = new Map(b.map((x) => [x.t, x.c]));
  return bucketStarts(b[0].t, to.getTime(), iv, tzOffset).map((t) => ({ t, c: map.get(t) ?? 0 }));
}

export function Histogram(props: { buckets: Bucket[]; interval: Interval; tzOffset: number; from: Date; to: Date; height?: number; onBrush: (from: Date, to: Date) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [brush, setBrush] = useState<{ x0: number; x1: number } | null>(null);
  /** Plot's figure element exposes its scales; only the x scale's inverse is used (brush → dates). */
  type PlotFigure = { scale?: (name: string) => { invert?: (v: number) => unknown } | undefined } | null;
  const drag = useRef<{ start: number; svg: SVGSVGElement; plot: PlotFigure } | null>(null);
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
    // a bar spans its bucket, whose end is the next bucket start (calendar months differ in length)
    const data = props.buckets.map((b) => ({ t: new Date(b.t), t2: new Date(nextBucketStart(b.t, props.interval, props.tzOffset)), c: b.c }));
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
      y: { label: t('hist.count'), grid: true, nice: true, tickFormat: fmtAxisNumber },
      marks: [
        Plot.rectY(data, { x1: 't', x2: 't2', y: 'c', fill: '#54b399', inset: 1, insetLeft: 0.5, insetRight: 0.5 }),
        Plot.ruleY([0]),
        Plot.tip(
          data,
          Plot.pointerX({
            x: 't',
            y: 'c',
            title: (d: { t: Date; c: number }) => `${formatBucket(d.t, props.interval.ms)}\n${t('hist.records', { n: d.c.toLocaleString() })}`,
          }),
        ),
      ],
    });
    // Plot renders in UTC for type 'utc'; shift to local time display by using local scale instead
    el.replaceChildren(plot);
    return () => plot.remove();
  }, [props.buckets, props.interval, props.tzOffset, props.from, props.to, width, lang, settings]);

  const onDown = (e: PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const svg = el.querySelector('svg');
    if (!svg) return;
    const rect = el.getBoundingClientRect();
    drag.current = { start: e.clientX - rect.left, svg, plot: el.firstElementChild as unknown as PlotFigure };
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
    const plot = drag.current.plot;
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
