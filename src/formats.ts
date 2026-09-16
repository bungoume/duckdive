// File formats and Data source templates for the AWS log families stored on S3.
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

import { lit } from './sql';
import { t, type MsgKey } from './i18n';

export type FormatId = 'auto' | 'parquet' | 'csv' | 'json' | 'alb' | 'cloudfront' | 'cloudtrail' | 'flowlogs' | 's3access' | 'ltsv' | 'cwlexport' | 'lines';

export interface FormatDef {
  id: FormatId;
  /** table function over the file list */
  reader: (list: string, withFilename: boolean) => string;
  /** extra SELECT expressions (start with ", ") */
  select?: string;
  /** wrap "SELECT … FROM reader" → e.g. unnest Records */
  wrap?: (inner: string) => string;
  /** preferred time field */
  timeField?: string;
  /** detect from the first URL */
  detect?: RegExp;
}

const fn = (withFilename: boolean) => (withFilename ? ', filename = true' : '');

function csvFixed(list: string, withFilename: boolean, columns: [string, string][], opts: string): string {
  const cols = '{' + columns.map(([n, t]) => `${lit(n)}: ${lit(t)}`).join(', ') + '}';
  return `read_csv(${list}, ${opts}, header = false, auto_detect = false, null_padding = true, strict_mode = false, columns = ${cols}${fn(withFilename)})`;
}

// ---- AWS ALB access logs: 34 fields as of 2026 (older files have fewer, new ones may append) ----
const ALB_COLUMNS: [string, string][] = [
  ['type', 'VARCHAR'], ['time', 'TIMESTAMP'], ['elb', 'VARCHAR'], ['client_port', 'VARCHAR'], ['target_port', 'VARCHAR'],
  ['request_processing_time', 'DOUBLE'], ['target_processing_time', 'DOUBLE'], ['response_processing_time', 'DOUBLE'],
  ['elb_status_code', 'INTEGER'], ['target_status_code', 'VARCHAR'], ['received_bytes', 'BIGINT'], ['sent_bytes', 'BIGINT'],
  ['request', 'VARCHAR'], ['user_agent', 'VARCHAR'], ['ssl_cipher', 'VARCHAR'], ['ssl_protocol', 'VARCHAR'], ['target_group_arn', 'VARCHAR'],
  ['trace_id', 'VARCHAR'], ['domain_name', 'VARCHAR'], ['chosen_cert_arn', 'VARCHAR'], ['matched_rule_priority', 'VARCHAR'], ['request_creation_time', 'TIMESTAMP'],
  ['actions_executed', 'VARCHAR'], ['redirect_url', 'VARCHAR'], ['error_reason', 'VARCHAR'], ['target_port_list', 'VARCHAR'], ['target_status_code_list', 'VARCHAR'],
  ['classification', 'VARCHAR'], ['classification_reason', 'VARCHAR'], ['conn_trace_id', 'VARCHAR'],
  ['transformed_host', 'VARCHAR'], ['transformed_uri', 'VARCHAR'], ['request_transform_status', 'VARCHAR'], ['ip_address', 'VARCHAR'],
];

// ---- CloudFront standard (legacy) logs: TSV with two header lines, 33 fields ----
const CLOUDFRONT_COLUMNS: [string, string][] = [
  ['date', 'DATE'], ['time', 'TIME'], ['x_edge_location', 'VARCHAR'], ['sc_bytes', 'BIGINT'], ['c_ip', 'VARCHAR'], ['cs_method', 'VARCHAR'],
  ['cs_host', 'VARCHAR'], ['cs_uri_stem', 'VARCHAR'], ['sc_status', 'INTEGER'], ['cs_referer', 'VARCHAR'], ['cs_user_agent', 'VARCHAR'],
  ['cs_uri_query', 'VARCHAR'], ['cs_cookie', 'VARCHAR'], ['x_edge_result_type', 'VARCHAR'], ['x_edge_request_id', 'VARCHAR'], ['x_host_header', 'VARCHAR'],
  ['cs_protocol', 'VARCHAR'], ['cs_bytes', 'BIGINT'], ['time_taken', 'DOUBLE'], ['x_forwarded_for', 'VARCHAR'], ['ssl_protocol', 'VARCHAR'], ['ssl_cipher', 'VARCHAR'],
  ['x_edge_response_result_type', 'VARCHAR'], ['cs_protocol_version', 'VARCHAR'], ['fle_status', 'VARCHAR'], ['fle_encrypted_fields', 'VARCHAR'], ['c_port', 'INTEGER'],
  ['time_to_first_byte', 'DOUBLE'], ['x_edge_detailed_result_type', 'VARCHAR'], ['sc_content_type', 'VARCHAR'], ['sc_content_len', 'BIGINT'],
  ['sc_range_start', 'VARCHAR'], ['sc_range_end', 'VARCHAR'],
];

// ---- S3 server access logs: space separated; the bracketed time is split in two tokens ----
const S3ACCESS_COLUMNS: [string, string][] = [
  ['bucket_owner', 'VARCHAR'], ['bucket', 'VARCHAR'], ['time1', 'VARCHAR'], ['time2', 'VARCHAR'], ['remote_ip', 'VARCHAR'], ['requester', 'VARCHAR'],
  ['request_id', 'VARCHAR'], ['operation', 'VARCHAR'], ['key', 'VARCHAR'], ['request_uri', 'VARCHAR'], ['http_status', 'INTEGER'], ['error_code', 'VARCHAR'],
  ['bytes_sent', 'VARCHAR'], ['object_size', 'VARCHAR'], ['total_time', 'VARCHAR'], ['turn_around_time', 'VARCHAR'], ['referer', 'VARCHAR'], ['user_agent', 'VARCHAR'],
  ['version_id', 'VARCHAR'], ['host_id', 'VARCHAR'], ['signature_version', 'VARCHAR'], ['cipher_suite', 'VARCHAR'], ['authentication_type', 'VARCHAR'],
  ['host_header', 'VARCHAR'], ['tls_version', 'VARCHAR'], ['access_point_arn', 'VARCHAR'], ['acl_required', 'VARCHAR'],
];

const LTSV_EXPR = `to_json(map_from_entries(list_transform(string_split(line, chr(9)), x -> struct_pack(key := split_part(x, ':', 1), value := x[length(split_part(x, ':', 1)) + 2:]))))`;

export const FORMATS: Record<Exclude<FormatId, 'auto'>, FormatDef> = {
  parquet: { id: 'parquet', reader: (l, f) => `read_parquet(${l}${fn(f)})` },
  csv: { id: 'csv', reader: (l, f) => `read_csv_auto(${l}${fn(f)})`, detect: /\.(csv|tsv|log|txt)(\.gz|\.zst)?$/ },
  json: {
    id: 'json',
    reader: (l, f) => `read_json_auto(${l}, union_by_name = true${fn(f)})`,
    // by extension, or by the delivery paths of AWS services that write JSON lines as *.log.gz
    detect: /\.(json|jsonl|ndjson)(\.gz|\.zst)?$|\/(WAFLogs|vpcdnsquerylogs|network-firewall)\//,
  },
  alb: {
    id: 'alb',
    reader: (l, f) => csvFixed(l, f, ALB_COLUMNS, `delim = ' ', quote = '"', escape = '"', timestampformat = '%Y-%m-%dT%H:%M:%S.%fZ'`),
    timeField: 'time',
    detect: /\/elasticloadbalancing\//,
  },
  cloudfront: {
    id: 'cloudfront',
    reader: (l, f) => csvFixed(l, f, CLOUDFRONT_COLUMNS, `delim = '\t', quote = '', escape = '', skip = 2`),
    select: `, (date || ' ' || time)::TIMESTAMP AS "timestamp"`,
    timeField: 'timestamp',
    detect: /[A-Z0-9]{13,14}\.\d{4}-\d{2}-\d{2}-\d{2}\.[^/]+\.gz$/,
  },
  cloudtrail: {
    id: 'cloudtrail',
    reader: (l, f) => `read_json_auto(${l}, union_by_name = true, maximum_object_size = 268435456${fn(f)})`,
    // one row per Record; the filename (if requested) is carried along
    wrap: (inner) => `SELECT rec.*, * EXCLUDE (rec) FROM (SELECT unnest(Records) AS rec, * EXCLUDE (Records) FROM (${inner}))`,
    timeField: 'eventTime',
    detect: /\/CloudTrail\//,
  },
  flowlogs: {
    id: 'flowlogs',
    reader: (l, f) => `read_csv_auto(${l}, delim = ' ', header = true${fn(f)})`,
    timeField: 'start',
    detect: /\/vpcflowlogs\//,
  },
  s3access: {
    id: 's3access',
    reader: (l, f) => csvFixed(l, f, S3ACCESS_COLUMNS, `delim = ' ', quote = '"', escape = '"'`),
    select: `, try_strptime(time1[2:] || ' ' || time2[:-2], '%d/%b/%Y:%H:%M:%S %z')::TIMESTAMP AS "timestamp"`,
    timeField: 'timestamp',
    detect: /\/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[A-F0-9]{16}$/,
  },
  ltsv: {
    id: 'ltsv',
    reader: (l, f) => `read_csv(${l}, delim = E'\\x01', quote = '', escape = '', header = false, auto_detect = false, null_padding = true, strict_mode = false, columns = {'line': 'VARCHAR'}${fn(f)})`,
    select: `, ${LTSV_EXPR} AS log`,
    detect: /\.ltsv(\.gz|\.zst)?$/,
  },
  cwlexport: {
    id: 'cwlexport',
    reader: (l, f) => `read_csv(${l}, delim = E'\\x01', quote = '', escape = '', header = false, auto_detect = false, null_padding = true, strict_mode = false, columns = {'line': 'VARCHAR'}${fn(f)})`,
    // "2026-09-11T00:00:00.000Z message…": the leading ISO timestamp becomes the time field
    select: `, TRY_CAST(split_part(line, ' ', 1) AS TIMESTAMP) AS "timestamp", line[length(split_part(line, ' ', 1)) + 2:] AS message`,
    timeField: 'timestamp',
  },
  lines: {
    id: 'lines',
    reader: (l, f) => `read_csv(${l}, delim = E'\\x01', quote = '', escape = '', header = false, auto_detect = false, null_padding = true, strict_mode = false, columns = {'line': 'VARCHAR'}${fn(f)})`,
  },
};

/** Display name of a format in the UI language. */
export function formatLabel(id: FormatId): string {
  return t(`fmt.${id}` as MsgKey);
}

export const FORMAT_IDS: FormatId[] = ['auto', 'parquet', 'csv', 'json', 'alb', 'cloudfront', 'cloudtrail', 'flowlogs', 's3access', 'ltsv', 'cwlexport', 'lines'];

export function detectFormat(urls: string[]): Exclude<FormatId, 'auto'> {
  const first = urls[0] ?? '';
  // Parquet wins over path hints: converted ALB logs or Flow Logs in Parquet still carry the
  // service name in their keys.
  if (/\.parquet$/i.test(first)) return 'parquet';
  for (const id of ['alb', 'cloudtrail', 'flowlogs', 'cloudfront', 's3access', 'ltsv', 'json', 'csv'] as const) {
    const d = FORMATS[id].detect;
    if (d && d.test(first)) return id;
  }
  return 'parquet';
}

export function resolveFormat(format: FormatId, urls: string[]): FormatDef {
  return FORMATS[format === 'auto' ? detectFormat(urls) : format];
}

// ---------- Data source templates ----------

export interface Template {
  id: string;
  format: FormatId;
  /** pattern with <bucket> (and optional <prefix>) placeholders the user must replace */
  urls: string;
}

/** Display name / explanatory note of a template in the UI language (keys tpl.<id>.label / .note). */
export function templateLabel(tp: Template): string {
  return t(`tpl.${tp.id}.label` as MsgKey);
}
export function templateNote(tp: Template): string {
  return t(`tpl.${tp.id}.note` as MsgKey);
}

export const TEMPLATES: Template[] = [
  {
    id: 'alb',
    format: 'alb',
    urls: 's3://<bucket>/AWSLogs/{account}/elasticloadbalancing/{region}/{yyyy}/{MM}/{dd}/{account}_elasticloadbalancing_{region}_app.{alb}.*.log.gz',
  },
  {
    id: 'alb-parquet',
    format: 'parquet',
    urls: 's3://<bucket>/<prefix>/{alb}/dt={yyyy}-{MM}-{dd}/hour={HH}/*.parquet',
  },
  {
    id: 'nlb',
    format: 'csv',
    urls: 's3://<bucket>/AWSLogs/{account}/elasticloadbalancing/{region}/{yyyy}/{MM}/{dd}/{account}_elasticloadbalancing_{region}_net.{nlb}.*.log.gz',
  },
  {
    id: 'cloudfront',
    format: 'cloudfront',
    urls: 's3://<bucket>/<prefix>/{distribution}.{yyyy}-{MM}-{dd}-{HH}.*.gz',
  },
  {
    id: 'cloudtrail',
    format: 'cloudtrail',
    urls: 's3://<bucket>/AWSLogs/{account}/CloudTrail/{region}/{yyyy}/{MM}/{dd}/{account}_CloudTrail_{region}_*.json.gz',
  },
  {
    id: 'flowlogs',
    format: 'flowlogs',
    urls: 's3://<bucket>/AWSLogs/{account}/vpcflowlogs/{region}/{yyyy}/{MM}/{dd}/{account}_vpcflowlogs_{region}_{flow_log_id}_*.log.gz',
  },
  {
    id: 'flowlogs-parquet',
    format: 'parquet',
    urls: 's3://<bucket>/AWSLogs/aws-account-id={account}/aws-service=vpc/aws-region={region}/year={yyyy}/month={MM}/day={dd}/hour={HH}/*.log.parquet',
  },
  {
    id: 'waf',
    format: 'json',
    urls: 's3://<bucket>/AWSLogs/{account}/WAFLogs/{region}/{webacl}/{yyyy}/{MM}/{dd}/{HH}/*/{account}_waflogs_{region}_{webacl}_*.log.gz',
  },
  {
    id: 'netfw',
    format: 'json',
    urls: 's3://<bucket>/AWSLogs/{account}/network-firewall/{log_type}/{region}/{firewall}/{yyyy}/{MM}/{dd}/{HH}/*.log.gz',
  },
  {
    id: 'r53resolver',
    format: 'json',
    urls: 's3://<bucket>/AWSLogs/{account}/vpcdnsquerylogs/{vpc}/{yyyy}/{MM}/{dd}/{vpc}_vpcdnsquerylogs_{account}_*.log.gz',
  },
  {
    id: 's3access',
    format: 's3access',
    urls: 's3://<bucket>/<prefix>/{yyyy}-{MM}-{dd}-{HH}-*',
  },
  {
    id: 'firehose',
    format: 'json',
    urls: 's3://<bucket>/<prefix>/{yyyy}/{MM}/{dd}/{HH}/*',
  },
  {
    id: 'cwlexport',
    format: 'cwlexport',
    urls: 's3://<bucket>/<prefix>/<task-id>/**',
  },
  {
    id: 'ssm',
    format: 'lines',
    urls: 's3://<bucket>/<prefix>/**',
  },
];
