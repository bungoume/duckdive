// Log patterns: a message with its numbers, addresses and ids replaced by tags is its template;
// grouping by the template shows what kinds of lines a text field holds. The masks are RE2
// expressions run inside DuckDB (regexp_replace), and the same masks turn a template back into
// a regular expression that matches its lines (a filter).
import { lit } from './sql';

export const MASKS: { tag: string; re: string }[] = [
  { tag: '<uuid>', re: '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' },
  { tag: '<ip>', re: '\\b\\d{1,3}(\\.\\d{1,3}){3}\\b' },
  { tag: '<hex>', re: '\\b[0-9a-fA-F]{12,}\\b' },
  // no trailing boundary: "1200ms" and "web-1" carry numbers too
  { tag: '<n>', re: '\\d+(\\.\\d+)?' },
];

/** SQL turning a string expression into its template (the first mask is applied first). */
export function templateExpr(expr: string): string {
  let e = expr;
  for (const m of MASKS) e = `regexp_replace(${e}, ${lit(m.re)}, ${lit(m.tag)}, 'g')`;
  return e;
}

/** An anchored RE2 expression matching every line of a template: text escaped, tags put back as their masks. */
export function templateRegex(tpl: string): string {
  const parts = tpl.split(/(<uuid>|<ip>|<hex>|<n>)/);
  const body = parts.map((p) => MASKS.find((m) => m.tag === p)?.re ?? p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return `^${body}$`;
}

/** SQL of a filter that keeps the lines of a template. */
export function templateFilterSql(expr: string, tpl: string): string {
  return `regexp_matches(${expr}, ${lit(templateRegex(tpl))})`;
}
