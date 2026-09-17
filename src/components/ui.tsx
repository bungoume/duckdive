import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { FieldKind } from '../fields';

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
