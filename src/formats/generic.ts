import { type FormatDef } from './types';
import { fn, readJson, readLines } from './shared';

const LTSV_EXPR = `to_json(map_from_entries(list_transform(string_split(line, chr(9)), x -> struct_pack(key := split_part(x, ':', 1), value := x[length(split_part(x, ':', 1)) + 2:]))))`;

export const parquetFormat: FormatDef = { id: 'parquet', reader: (l, f) => `read_parquet(${l}${fn(f)})` };

export const csvFormat: FormatDef = { id: 'csv', reader: (l, f) => `read_csv_auto(${l}${fn(f)})`, detect: /\.(csv|tsv|log|txt)(\.gz|\.zst)?$/ };

export const jsonFormat: FormatDef = {
  id: 'json',
  reader: readJson,
  // by extension, or by the delivery paths of AWS services that write JSON lines as *.log.gz
  detect: /\.(json|jsonl|ndjson)(\.gz|\.zst)?$|\/network-firewall\//,
};

export const ltsvFormat: FormatDef = {
  id: 'ltsv',
  reader: readLines,
  select: `, ${LTSV_EXPR} AS log`,
  detect: /\.ltsv(\.gz|\.zst)?$/,
};

export const cwlexportFormat: FormatDef = {
  id: 'cwlexport',
  reader: readLines,
  // "2026-09-11T00:00:00.000Z message…": the leading ISO timestamp becomes the time field
  select: `, TRY_CAST(split_part(line, ' ', 1) AS TIMESTAMP) AS "timestamp", line[length(split_part(line, ' ', 1)) + 2:] AS message`,
  timeField: 'timestamp',
};

export const linesFormat: FormatDef = {
  id: 'lines',
  reader: readLines,
};
