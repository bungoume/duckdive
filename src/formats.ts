// File format registry. Readers and projections live together under formats/;
// Data source form presets live in sourceTemplates.ts.
//
// Each format says how to turn a list of files into a table (`reader`), which derived
// columns to add (`select`), how to wrap the result (`wrap`, e.g. CloudTrail's Records array),
// and which field is the time field. Fixed layouts use `auto_detect = false` so that binding
// the view reads nothing from S3.
//
// Binding cost matters: the view is bound at connect time and again by every query. With
// `union_by_name = true` DuckDB opens every file at bind time (all Parquet footers, or every
// gzip file whole for text formats). Parquet / CSV therefore take their schema from the first
// file only; JSON keeps union_by_name because its keys legitimately differ between files.

import { type FormatId, type FormatDef, type OtelByName, type Naming } from './formats/types';
import { parquetFormat, csvFormat, jsonFormat, ltsvFormat, cwlexportFormat, linesFormat } from './formats/generic';
import { albFormat } from './formats/alb';
import { cloudfrontFormat } from './formats/cloudfront';
import { cloudtrailFormat } from './formats/cloudtrail';
import { wafFormat } from './formats/waf';
import { r53resolverFormat } from './formats/r53resolver';
import { flowlogsFormat } from './formats/flowlogs';
import { s3accessFormat } from './formats/s3access';
import { gcplogFormat } from './formats/gcplog';
import { cflogpushFormat } from './formats/cflogpush';
import { t } from './i18n';

export const FORMATS: Record<Exclude<FormatId, 'auto'>, FormatDef> = {
  parquet: parquetFormat,
  csv: csvFormat,
  json: jsonFormat,
  alb: albFormat,
  cloudfront: cloudfrontFormat,
  cloudtrail: cloudtrailFormat,
  waf: wafFormat,
  r53resolver: r53resolverFormat,
  flowlogs: flowlogsFormat,
  s3access: s3accessFormat,
  gcplog: gcplogFormat,
  cflogpush: cflogpushFormat,
  ltsv: ltsvFormat,
  cwlexport: cwlexportFormat,
  lines: linesFormat,
};

/** Flow log fields are hyphenated in text delivery and underscored in Parquet: one key for both. */
const fieldKey = (name: string) => name.replace(/-/g, '_').toLowerCase();

const quoteName = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * SELECT list that maps the columns a source turns out to have. `keep` names the columns that are
 * duckdive's own rather than the log's ({name} tokens of the pattern, _file) and are left alone.
 */
export function otelRename(byName: OtelByName, columns: string[], keep: Set<string>): string {
  const out: string[] = [];
  for (const col of columns) {
    const quoted = quoteName(col);
    if (keep.has(col)) {
      out.push(quoted);
      continue;
    }
    const key = fieldKey(col);
    const entry = Object.hasOwn(byName.map, key) ? byName.map[key] : undefined;
    if (entry) for (const [name, expr] of entry) out.push(`${expr ? expr.replace('{}', quoted) : quoted} AS ${quoteName(name)}`);
    else out.push(`${quoted} AS ${quoteName(byName.prefix + key)}`);
  }
  return out.join(', ');
}

/** Display name of a field naming in the UI language. */
export function namingLabel(id: Naming): string {
  return t(`naming.${id}`);
}

/** Display name of a format in the UI language. */
export function formatLabel(id: FormatId): string {
  return t(`fmt.${id}`);
}

export const FORMAT_IDS: FormatId[] = [
  'auto',
  'parquet',
  'csv',
  'json',
  'alb',
  'cloudfront',
  'cloudtrail',
  'flowlogs',
  's3access',
  'waf',
  'r53resolver',
  'gcplog',
  'cflogpush',
  'ltsv',
  'cwlexport',
  'lines',
];

export function detectFormat(urls: string[]): Exclude<FormatId, 'auto'> {
  const first = urls[0] ?? '';
  // Parquet wins over path hints: converted ALB logs or Flow Logs in Parquet still carry the
  // service name in their keys.
  if (/\.parquet$/i.test(first)) return 'parquet';
  for (const id of ['alb', 'cloudtrail', 'flowlogs', 'cloudfront', 's3access', 'waf', 'r53resolver', 'ltsv', 'json', 'csv'] as const) {
    const d = FORMATS[id].detect;
    if (d && d.test(first)) return id;
  }
  return 'parquet';
}

export function resolveFormat(format: FormatId, urls: string[]): FormatDef {
  return FORMATS[format === 'auto' ? detectFormat(urls) : format];
}

/** Whether a format can be read under the OpenTelemetry names. */
export function hasOtel(fmt: FormatDef): boolean {
  return !!(fmt.otel || fmt.otelByName);
}

/** The preferred time field of a format, which the OTel projection renames to "timestamp". */
export function timeFieldFor(fmt: FormatDef, naming: Naming): string | undefined {
  return naming === 'otel' && hasOtel(fmt) ? 'timestamp' : fmt.timeField;
}

/** SELECT list of the OTel projection, or null for a format that has none (it is then read under its own names). */
export function otelSelect(fmt: FormatDef): string | null {
  return fmt.otel ? fmt.otel.columns.map(([name, expr]) => `${expr} AS "${name}"`).join(', ') : null;
}

/** The reader a format is read through under `naming`, and whether its wrap still applies. */
export function readerFor(fmt: FormatDef, naming: Naming): { reader: FormatDef['reader']; wrap?: FormatDef['wrap'] } {
  const otel = naming === 'otel' ? fmt.otel : undefined;
  return otel?.reader ? { reader: otel.reader } : { reader: fmt.reader, wrap: fmt.wrap };
}

export type { FormatId, FormatDef, Naming, OtelByName, OtelProjection } from './formats/types';
export { NAMING_IDS } from './formats/types';
