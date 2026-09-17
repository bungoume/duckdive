import * as Plot from '@observablehq/plot';
import { t, useLang } from '../i18n';
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatBucket } from '../datefmt';
import { useSettings } from '../settings';
import { timeAxis } from '../ticks';
import { NULL_GROUP, OTHER, groupLabel, metricLabel, type VisResult } from '../queries';
import { bucketStarts, nextBucketStart, type Interval } from '../sql';
import type { ChartType, MetricDef } from '../state';
import { fmtAxisNumber, fmtNum } from './ui';

export const PALETTE = ['#54B399', '#6092C0', '#D36086', '#9170B8', '#CA8EAE', '#D6BF57', '#B9A888', '#DA8B45', '#AA6556', '#E7664C'];

interface Series {
  x: Date | string | number;
  s: string;
  y: number;
}

/** Turn a VisResult into long-form series data, one series per (metric x group). */
export function toSeries(r: VisResult, metrics: MetricDef[]): { data: Series[]; series: string[]; xDomain: (Date | string | number)[] } {
  const hasG = r.groups.length > 0;
  const metricIdx = hasG ? [0] : metrics.map((_, i) => i);
  const series: string[] = [];
  const seriesName = (g: string | null, mi: number) => (hasG ? (g ?? NULL_GROUP) : metricLabel(metrics[mi]));
  if (hasG) series.push(...r.groups);
  else series.push(...metricIdx.map((i) => metricLabel(metrics[i])));

  let xs: (number | string)[] = r.xOrder;
  if (r.xKind === 'date_histogram' && r.interval && xs.length) {
    // every bucket between the first and the last, so gaps show as zeros (calendar months included)
    const nums = xs as number[];
    xs = bucketStarts(nums[0], nums[nums.length - 1], r.interval, r.tzOffset);
  }
  const key = (x: number | string | null, s: string) => `${x} ${s}`;
  const map = new Map<string, number>();
  for (const row of r.rows) {
    if (row.x === null) continue;
    for (const mi of metricIdx) map.set(key(row.x, seriesName(row.g, mi)), row.m[mi]);
  }
  const data: Series[] = [];
  const conv = (x: number | string) => (r.xKind === 'date_histogram' ? new Date(x as number) : x);
  for (const x of xs) {
    for (const s of series) {
      const v = map.get(key(x, s));
      data.push({ x: conv(x), s, y: v === undefined || Number.isNaN(v) ? 0 : v });
    }
  }
  return { data, series, xDomain: xs.map(conv) };
}

export interface ChartPick {
  /** x value under the cursor (Date for date histograms, string for terms, number for histograms) */
  x: Date | string | number;
  /** series name: breakdown value, or the metric label when there is no breakdown */
  series: string;
  value: number;
  isTime: boolean;
  intervalMs: number;
}

interface Hit extends ChartPick {
  px: number;
  py: number;
  xIndex: number;
  sIndex: number;
}

export function Chart(props: {
  result: VisResult;
  metrics: MetricDef[];
  chart: ChartType;
  onBrush?: (from: Date, to: Date) => void;
  /** click on a point / band → filter by it */
  onPick?: (pick: ChartPick) => void;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [brush, setBrush] = useState<{ x0: number; x1: number } | null>(null);
  const [hover, setHover] = useState<Hit | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  // hit-testing model rebuilt with every render of the plot
  const model = useRef<{
    plot: { scale?: (n: string) => { invert?: (v: number) => unknown; apply?: (v: unknown) => number; bandwidth?: number; domain?: unknown[] } } | null;
    stacked: boolean;
    isTime: boolean;
    isBand: boolean;
    ivMs: number;
    iv: Interval | null;
    tzOffset: number;
    xs: (Date | string | number)[];
    series: string[];
    /** per x: series → [y0, y1] (stacked) or value (line) */
    bands: Map<string, { s: string; y0: number; y1: number; v: number }[]>;
  }>({ plot: null, stacked: false, isTime: false, isBand: false, ivMs: 0, iv: null, tzOffset: 0, xs: [], series: [], bands: new Map() });
  const highlighted = useRef<Element | null>(null);
  // axis / legend labels are baked into the plot: rebuild it when the language changes
  const lang = useLang();
  const settings = useSettings();

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((es) => setWidth(Math.max(320, Math.floor(es[0].contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { data, series, xDomain } = toSeries(props.result, props.metrics);
    const isTime = props.result.xKind === 'date_histogram';
    const isBand = props.result.xKind === 'terms';
    const color = {
      domain: series,
      range: series.map((s, i) => (s === OTHER ? '#98a2b3' : PALETTE[i % PALETTE.length])),
      legend: series.length > 1 || props.result.groups.length > 0,
      tickFormat: groupLabel,
    };
    const yLabel = props.result.groups.length ? metricLabel(props.metrics[0]) : props.metrics.length === 1 ? metricLabel(props.metrics[0]) : t('chart.value');
    const marks: unknown[] = [Plot.ruleY([0])];
    const ivMs = props.result.interval?.ms ?? 0;
    // end of the bucket starting at t (calendar months differ in length)
    const iv = props.result.interval;
    const bucketEnd = (t: number) => (iv ? nextBucketStart(t, iv, props.result.tzOffset) : t + ivMs);
    const stacked = props.chart === 'area' || props.chart === 'bar';
    if (props.chart === 'line') {
      marks.push(Plot.lineY(data, { x: 'x', y: 'y', stroke: 's', strokeWidth: 2, curve: 'monotone-x' }));
    } else if (props.chart === 'area') {
      marks.push(Plot.areaY(data, { x: 'x', y: 'y', fill: 's', fillOpacity: 0.85, order: series, curve: 'monotone-x' }));
      marks.push(Plot.lineY(data, Plot.stackY2({ x: 'x', y: 'y', stroke: 's', order: series, strokeWidth: 1, curve: 'monotone-x' })));
    } else if (props.chart === 'bar') {
      if (isTime) {
        const d2 = data.map((d) => ({ ...d, x2: new Date(bucketEnd((d.x as Date).getTime())) }));
        marks.push(Plot.rectY(d2, { x1: 'x', x2: 'x2', y: 'y', fill: 's', order: series, inset: 0.5 }));
      } else {
        marks.push(Plot.barY(data, { x: 'x', y: 'y', fill: 's', order: series }));
      }
    }
    // hit-test model: stack the series in plot order per x
    const bands = new Map<string, { s: string; y0: number; y1: number; v: number }[]>();
    const keyOf = (x: Date | string | number) => (x instanceof Date ? String(x.getTime()) : String(x));
    for (const x of xDomain) bands.set(keyOf(x), []);
    for (const s of series) {
      for (const d of data) {
        if (d.s !== s) continue;
        const list = bands.get(keyOf(d.x))!;
        const y0 = stacked ? (list.length ? list[list.length - 1].y1 : 0) : 0;
        list.push({ s, y0, y1: stacked ? y0 + d.y : d.y, v: d.y });
      }
    }
    // time axis: wall-clock aligned ticks that fit the plot width, labelled as briefly as the range allows
    const marginLeft = 56;
    const marginRight = 20;
    let xTime: Record<string, unknown> = { type: 'time', label: null, grid: false, tickFormat: (d: Date) => formatBucket(d, ivMs) };
    if (isTime && xDomain.length) {
      const ts = xDomain as Date[];
      const t0 = ts[0];
      const t1 = new Date(props.chart === 'bar' ? bucketEnd(ts[ts.length - 1].getTime()) : ts[ts.length - 1].getTime());
      const axis = timeAxis(t0, t1, width - marginLeft - marginRight, ivMs);
      xTime = { type: 'time', domain: [t0, t1], label: null, grid: false, ticks: axis.ticks, tickFormat: axis.tickFormat };
    }
    let plot: (HTMLElement | SVGSVGElement) & { remove(): void };
    try {
      plot = Plot.plot({
        width,
        height: props.height ?? 360,
        marginLeft,
        marginRight,
        marginBottom: isBand ? 60 : 30,
        style: { fontSize: '11px', background: 'transparent', overflow: 'visible' },
        color,
        x: isTime ? xTime : isBand ? { domain: xDomain as string[], label: null, tickRotate: xDomain.length > 8 ? -30 : 0 } : { label: null },
        y: {
          label: yLabel,
          grid: true,
          nice: true,
          tickFormat: fmtAxisNumber,
        },
        marks: marks as Plot.Markish[],
      });
    } catch (e) {
      console.error('chart render failed', e);
      const div = document.createElement('div');
      div.className = 'chart-error';
      div.textContent = t('chart.renderFailed', { error: String(e) });
      el.replaceChildren(div);
      model.current.plot = null;
      return;
    }
    el.replaceChildren(plot);
    model.current = { plot: plot as unknown as typeof model.current.plot, stacked, isTime, isBand, ivMs, iv, tzOffset: props.result.tzOffset, xs: xDomain, series, bands };
    highlighted.current = null;
    setHover(null);
    return () => plot.remove();
  }, [props.result, props.metrics, props.chart, props.height, width, lang, settings]);

  /** The plot's own <svg> (with a legend, Plot renders small swatch svgs before it). */
  const chartSvg = (): SVGSVGElement | null => {
    const box = ref.current;
    if (!box) return null;
    let best: SVGSVGElement | null = null;
    for (const el of box.querySelectorAll('svg')) if (!best || el.clientWidth > best.clientWidth) best = el;
    return best;
  };

  /** Find the (x, series) under a point given in chart-box coordinates. */
  const hitTest = (px: number, py: number): Hit | null => {
    const m = model.current;
    const box = ref.current;
    if (!m.plot || !box) return null;
    const svg = chartSvg();
    if (!svg) return null;
    const r = box.getBoundingClientRect();
    const sr = svg.getBoundingClientRect();
    // Plot's scales work in the svg's own units; if CSS shrank the svg (max-width: 100%), rescale
    const kx = svg.width.baseVal.value / (sr.width || 1);
    const ky = svg.height.baseVal.value / (sr.height || 1);
    const sx = (px - (sr.left - r.left)) * kx;
    const sy = (py - (sr.top - r.top)) * ky;
    const xscale = m.plot.scale?.('x');
    const yscale = m.plot.scale?.('y');
    if (!xscale || !yscale?.invert) return null;
    const bucketEnd = (t: number) => (m.iv ? nextBucketStart(t, m.iv, m.tzOffset) : t + m.ivMs);
    let x: Date | string | number | null = null;
    if (m.isBand) {
      const bw = xscale.bandwidth ?? 0;
      for (const v of m.xs) {
        const left = xscale.apply?.(v) ?? NaN;
        if (sx >= left - 1 && sx <= left + bw + 1) {
          x = v;
          break;
        }
      }
    } else if (xscale.invert) {
      const xv = xscale.invert(sx);
      const t = xv instanceof Date ? xv.getTime() : Number(xv);
      // nearest x (bars/areas: the bucket containing the cursor)
      let best: Date | string | number | null = null;
      let bestD = Infinity;
      for (const v of m.xs) {
        const tv = v instanceof Date ? v.getTime() : Number(v);
        const d = m.isTime && m.ivMs ? (t >= tv && t < bucketEnd(tv) ? 0 : Math.abs(t - tv)) : Math.abs(t - tv);
        if (d < bestD) {
          bestD = d;
          best = v;
        }
      }
      x = best;
    }
    if (x === null) return null;
    const list = m.bands.get(x instanceof Date ? String(x.getTime()) : String(x)) ?? [];
    if (!list.length) return null;
    const yv = Number(yscale.invert(sy));
    let pick: (typeof list)[number] | undefined;
    if (m.stacked) {
      // only when the cursor is inside a band (empty space shows nothing)
      pick = list.find((b) => b.v > 0 && yv >= b.y0 && yv <= b.y1);
    } else {
      // lines: within 12 px of a series' value
      const apply = yscale.apply;
      if (apply) {
        let bestD = 12;
        for (const b of list) {
          const d = Math.abs(apply(b.v) - sy);
          if (d < bestD) {
            bestD = d;
            pick = b;
          }
        }
      }
    }
    if (!pick) return null;
    // intervalMs is the length of this bucket (calendar months differ), so x + intervalMs is its end
    const intervalMs = m.isTime && x instanceof Date ? bucketEnd(x.getTime()) - x.getTime() : m.ivMs;
    return { x, series: pick.s, value: pick.v, isTime: m.isTime, intervalMs, px, py, xIndex: m.xs.indexOf(x), sIndex: m.series.indexOf(pick.s) };
  };

  /** Emphasise the mark under the cursor (area / line path of the series, or the bar itself). */
  const highlight = (hit: Hit | null) => {
    const prev = highlighted.current as (SVGElement & { dataset: DOMStringMap }) | null;
    if (prev) {
      prev.style.filter = '';
      prev.style.stroke = prev.dataset.ddvStroke ?? '';
      prev.style.strokeWidth = prev.dataset.ddvStrokeWidth ?? '';
      highlighted.current = null;
    }
    if (!hit || !ref.current) return;
    const svg = chartSvg();
    if (!svg) return;
    const el: Element | null =
      props.chart === 'bar'
        ? (svg.querySelectorAll('g[aria-label="rect"] rect, g[aria-label="bar"] rect')[hit.xIndex * model.current.series.length + hit.sIndex] ?? null)
        : props.chart === 'area'
          ? (svg.querySelectorAll('g[aria-label="area"] path')[hit.sIndex] ?? null)
          : (svg.querySelectorAll('g[aria-label="line"] path')[hit.sIndex] ?? null);
    if (!el) return;
    const se = el as SVGElement & { dataset: DOMStringMap };
    se.dataset.ddvStroke = se.style.stroke;
    se.dataset.ddvStrokeWidth = se.style.strokeWidth;
    // a clearly visible emphasis: darker / more saturated fill plus a dark outline
    se.style.filter = props.chart === 'line' ? 'drop-shadow(0 0 3px rgba(0,0,0,0.6))' : 'brightness(0.7) saturate(1.6)';
    if (props.chart !== 'line') {
      se.style.stroke = '#1a1c21';
      se.style.strokeWidth = '2';
      se.style.strokeLinejoin = 'round';
    } else se.style.strokeWidth = '4';
    highlighted.current = el;
  };

  const isTime = props.result.xKind === 'date_histogram';
  const onDown = (e: PointerEvent) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    drag.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // the brush bar only appears once the pointer has actually moved (a click is not a brush)
  };
  const onMove = (e: PointerEvent) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (drag.current && isTime && props.onBrush && (brush || Math.abs(px - drag.current.x) >= 4)) setBrush({ x0: drag.current.x, x1: px });
    const hit = hitTest(px, py);
    setHover(hit);
    highlight(hit);
  };
  const onLeave = () => {
    setHover(null);
    highlight(null);
  };
  const onUp = (e: PointerEvent) => {
    if (!drag.current || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const start = drag.current;
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    drag.current = null;
    setBrush(null);
    if (Math.abs(start.x - px) < 4 && Math.abs(start.y - py) < 4) {
      // a click: filter by the point under the cursor
      const hit = hitTest(px, py);
      if (hit && props.onPick) props.onPick(hit);
      return;
    }
    if (!isTime || !props.onBrush || !brush) return;
    const fig = ref.current.firstElementChild as unknown as { scale?: (n: string) => { invert?: (v: number) => unknown } } | null;
    const svg = chartSvg();
    if (!fig || !svg) return;
    const sr = svg.getBoundingClientRect();
    const off = sr.left - rect.left;
    const kx = svg.width.baseVal.value / (sr.width || 1);
    const xs = fig.scale?.('x');
    if (!xs?.invert) return;
    const d0 = xs.invert((Math.min(start.x, px) - off) * kx);
    const d1 = xs.invert((Math.max(start.x, px) - off) * kx);
    if (d0 instanceof Date && d1 instanceof Date && !isNaN(d0.getTime())) props.onBrush(d0, d1);
  };

  const fmtX = (x: Date | string | number) => (x instanceof Date ? formatBucket(x, props.result.interval?.ms ?? 0) : String(x));
  const tipLeft = hover ? Math.min(hover.px + 12, width - 260) : 0;
  const tipTop = hover ? Math.max(0, hover.py - 10) : 0;
  const hasBreakdown = props.result.groups.length > 0;

  return (
    <div
      class="chart-box"
      onPointerDownCapture={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onLeave}
      style={{ cursor: brush ? 'crosshair' : hover && props.onPick ? 'pointer' : isTime && props.onBrush ? 'crosshair' : 'default' }}
    >
      <div ref={ref} />
      {brush && <div class="brush" style={{ left: Math.min(brush.x0, brush.x1), width: Math.abs(brush.x1 - brush.x0) }} />}
      {hover && (
        <div class="chart-tip" style={{ left: tipLeft, top: tipTop }}>
          <div class="chart-tip-x">
            {fmtX(hover.x)}
            {hover.isTime && hover.intervalMs ? ` – ${formatBucket(new Date((hover.x as Date).getTime() + hover.intervalMs), hover.intervalMs)}` : ''}
          </div>
          <div class="chart-tip-row">
            <span class="chart-tip-key">{groupLabel(hover.series)}</span>
            <span class="chart-tip-val">{fmtNum(hover.value)}</span>
          </div>
          {props.onPick && (
            <div class="chart-tip-hint">{(hasBreakdown && hover.series !== OTHER) || props.result.xKind === 'terms' ? t('chart.clickFilter') : hover.isTime ? t('chart.clickZoom') : ''}</div>
          )}
        </div>
      )}
    </div>
  );
}
