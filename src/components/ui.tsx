import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { FieldKind } from '../fields';

export function Popover(props: { open: boolean; onClose: () => void; button: ComponentChildren; children: ComponentChildren; align?: 'left' | 'right'; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [props.open]);
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

export function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
