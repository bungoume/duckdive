import { cloneElement, isValidElement, toChildArray, type ComponentChildren } from 'preact';
import { useEffect, useId, useRef } from 'preact/hooks';
import { fmtBytes } from '../cache';
import type { FieldKind } from '../fields';
import { getSettings } from '../settings';

export function Popover(props: { open: boolean; onClose: () => void; button: ComponentChildren; children: ComponentChildren; align?: 'left' | 'right'; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { open, onClose } = props;
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  return (
    <div class="popover-anchor" ref={ref}>
      {props.button}
      {props.open && (
        <div class={'popover' + (props.align === 'right' ? ' right' : '')} style={props.width ? { width: props.width } : undefined}>
          {props.children}
        </div>
      )}
    </div>
  );
}

/**
 * A form row: the label is linked to the control through a generated id. The control is the
 * first child; anything after it (hints, validation messages) is rendered below.
 */
export function FormField(props: { label: string; children: ComponentChildren; class?: string; style?: string }) {
  const id = useId();
  const [control, ...rest] = toChildArray(props.children);
  return (
    <div class={props.class ? `field-row ${props.class}` : 'field-row'} style={props.style}>
      <label for={id}>{props.label}</label>
      {isValidElement(control) ? cloneElement(control, { id }) : control}
      {rest}
    </div>
  );
}

export function FieldIcon({ kind }: { kind: FieldKind }) {
  const label: Record<FieldKind, string> = { string: 't', number: '#', date: '◷', boolean: '✓', object: '{}', list: '[]', json: 'J', unknown: '?' };
  return (
    <span class={'ficon kind-' + kind} title={kind}>
      {label[kind]}
    </span>
  );
}

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** Compact axis label: 1234 → "1.2k", 12345 → "12k". */
export function fmtAxisNumber(d: number): string {
  return Math.abs(d) >= 1000 ? `${(d / 1000).toFixed(Math.abs(d) >= 10000 ? 0 : 1)}k` : String(d);
}

export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** "83.9 ms", "1.23 s", "2.5 min" for a number of milliseconds. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${fmtNum(ms, 1)} ms`;
  if (ms < 60_000) return `${fmtNum(ms / 1000, 2)} s`;
  if (ms < 3_600_000) return `${fmtNum(ms / 60_000, 1)} min`;
  return `${fmtNum(ms / 3_600_000, 1)} h`;
}

const BYTES_NAME = /(^|[._])(bytes|size)$/i;
const MS_NAME = /_ms$/i;

/**
 * A value of the document table: numbers of fields named …bytes / …size or …_ms are shown as
 * sizes and durations when the setting says so (the raw value stays in the tooltip).
 */
export function fmtField(name: string, v: unknown): { text: string; raw?: string } {
  const text = fmtValue(v);
  if (!getSettings().formatByName) return { text };
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null;
  if (n === null || !Number.isFinite(n)) return { text };
  if (BYTES_NAME.test(name)) return { text: fmtBytes(n), raw: text };
  if (MS_NAME.test(name)) return { text: fmtDuration(n), raw: text };
  return { text };
}
