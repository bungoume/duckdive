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
import { t } from './i18n';

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
  /** projection under the OpenTelemetry names ([name, expression]); the time field is then "timestamp" */
  otel?: [string, string][];
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
  ['type', 'VARCHAR'],
  ['time', 'TIMESTAMP'],
  ['elb', 'VARCHAR'],
  ['client_port', 'VARCHAR'],
  ['target_port', 'VARCHAR'],
  ['request_processing_time', 'DOUBLE'],
  ['target_processing_time', 'DOUBLE'],
  ['response_processing_time', 'DOUBLE'],
  ['elb_status_code', 'INTEGER'],
  ['target_status_code', 'VARCHAR'],
  ['received_bytes', 'BIGINT'],
  ['sent_bytes', 'BIGINT'],
  ['request', 'VARCHAR'],
  ['user_agent', 'VARCHAR'],
  ['ssl_cipher', 'VARCHAR'],
  ['ssl_protocol', 'VARCHAR'],
  ['target_group_arn', 'VARCHAR'],
  ['trace_id', 'VARCHAR'],
  ['domain_name', 'VARCHAR'],
  ['chosen_cert_arn', 'VARCHAR'],
  ['matched_rule_priority', 'VARCHAR'],
  ['request_creation_time', 'TIMESTAMP'],
  ['actions_executed', 'VARCHAR'],
  ['redirect_url', 'VARCHAR'],
  ['error_reason', 'VARCHAR'],
  ['target_port_list', 'VARCHAR'],
  ['target_status_code_list', 'VARCHAR'],
  ['classification', 'VARCHAR'],
  ['classification_reason', 'VARCHAR'],
  ['conn_trace_id', 'VARCHAR'],
  ['transformed_host', 'VARCHAR'],
  ['transformed_uri', 'VARCHAR'],
  ['request_transform_status', 'VARCHAR'],
  ['ip_address', 'VARCHAR'],
];

// ---- CloudFront standard (legacy) logs: TSV with two header lines, 33 fields ----
const CLOUDFRONT_COLUMNS: [string, string][] = [
  ['date', 'DATE'],
  ['time', 'TIME'],
  ['x_edge_location', 'VARCHAR'],
  ['sc_bytes', 'BIGINT'],
  ['c_ip', 'VARCHAR'],
  ['cs_method', 'VARCHAR'],
  ['cs_host', 'VARCHAR'],
  ['cs_uri_stem', 'VARCHAR'],
  ['sc_status', 'INTEGER'],
  ['cs_referer', 'VARCHAR'],
  ['cs_user_agent', 'VARCHAR'],
  ['cs_uri_query', 'VARCHAR'],
  ['cs_cookie', 'VARCHAR'],
  ['x_edge_result_type', 'VARCHAR'],
  ['x_edge_request_id', 'VARCHAR'],
  ['x_host_header', 'VARCHAR'],
  ['cs_protocol', 'VARCHAR'],
  ['cs_bytes', 'BIGINT'],
  ['time_taken', 'DOUBLE'],
  ['x_forwarded_for', 'VARCHAR'],
  ['ssl_protocol', 'VARCHAR'],
  ['ssl_cipher', 'VARCHAR'],
  ['x_edge_response_result_type', 'VARCHAR'],
  ['cs_protocol_version', 'VARCHAR'],
  ['fle_status', 'VARCHAR'],
  ['fle_encrypted_fields', 'VARCHAR'],
  ['c_port', 'INTEGER'],
  ['time_to_first_byte', 'DOUBLE'],
  ['x_edge_detailed_result_type', 'VARCHAR'],
  ['sc_content_type', 'VARCHAR'],
  ['sc_content_len', 'BIGINT'],
  ['sc_range_start', 'VARCHAR'],
  ['sc_range_end', 'VARCHAR'],
];

// ---- S3 server access logs: space separated; the bracketed time is split in two tokens ----
const S3ACCESS_COLUMNS: [string, string][] = [
  ['bucket_owner', 'VARCHAR'],
  ['bucket', 'VARCHAR'],
  ['time1', 'VARCHAR'],
  ['time2', 'VARCHAR'],
  ['remote_ip', 'VARCHAR'],
  ['requester', 'VARCHAR'],
  ['request_id', 'VARCHAR'],
  ['operation', 'VARCHAR'],
  ['key', 'VARCHAR'],
  ['request_uri', 'VARCHAR'],
  ['http_status', 'INTEGER'],
  ['error_code', 'VARCHAR'],
  ['bytes_sent', 'VARCHAR'],
  ['object_size', 'VARCHAR'],
  ['total_time', 'VARCHAR'],
  ['turn_around_time', 'VARCHAR'],
  ['referer', 'VARCHAR'],
  ['user_agent', 'VARCHAR'],
  ['version_id', 'VARCHAR'],
  ['host_id', 'VARCHAR'],
  ['signature_version', 'VARCHAR'],
  ['cipher_suite', 'VARCHAR'],
  ['authentication_type', 'VARCHAR'],
  ['host_header', 'VARCHAR'],
  ['tls_version', 'VARCHAR'],
  ['access_point_arn', 'VARCHAR'],
  ['acl_required', 'VARCHAR'],
];

// ---- Derived timestamps, shared by the native `select` and the OTel projection ----
const CLOUDFRONT_TIME = `("date" || ' ' || "time")::TIMESTAMP`;
const S3ACCESS_TIME = `try_strptime("time1"[2:] || ' ' || "time2"[:-2], '%d/%b/%Y:%H:%M:%S %z')::TIMESTAMP`;

// ---- OpenTelemetry field names ----
//
// A fixed layout can be read under its own field names (`native`) or under the names of the
// OpenTelemetry semantic conventions (`otel`). The second is a projection: every column of the
// layout appears exactly once, renamed, and a few are split into the parts the conventions ask
// for (host:port, the request line, the TLS version). Values are not rewritten; a derived column
// is NULL when the text it is derived from does not have that part.
//
// Names that the conventions do not cover — most of what a load balancer logs — keep the AWS
// field name under the vendor namespace of the service (aws.alb.*, aws.cloudfront.*, aws.s3.*).
// Other providers follow the same rule with their own namespace (gcp.*, cloudflare.*).

export type Naming = 'native' | 'otel';

export const NAMING_IDS: Naming[] = ['native', 'otel'];

/** "host:port" → the address; split at the last colon so an IPv6 address survives. A value that is not host:port ("-") is kept as it is. */
const addrOf = (c: string) => `coalesce(nullif(regexp_extract(${c}, '^(.*):[0-9]+$', 1), ''), ${c})`;
const portOf = (c: string) => `TRY_CAST(nullif(regexp_extract(${c}, '^.*:([0-9]+)$', 1), '') AS INTEGER)`;

/** "TLSv1.2" → "tls" / "1.2"; anything else, "-" included, is NULL. */
const tlsName = (c: string) => `nullif(regexp_extract(lower(${c}), '^(tls|ssl)', 1), '')`;
const tlsVersion = (c: string) => `nullif(regexp_extract(${c}, '^[A-Za-z]+v?([0-9][0-9.]*)$', 1), '')`;

/** Request line "GET <target> HTTP/1.1": 1 = method, 2 = target, 3 = protocol name, 4 = version. A malformed line ("- - -") gives NULL. */
const reqLine = (c: string, g: 1 | 2 | 3 | 4) => `nullif(regexp_extract(${c}, '^([A-Z]+) (\\S+) ([A-Za-z]+)/([0-9.]+)$', ${g}), '')`;

/** One part of the URL in `u`, NULL when the URL has no such part. */
const urlPart = (u: string, re: string) => `nullif(regexp_extract(${u}, '${re}', 1), '')`;
const RE_SCHEME = '^([a-zA-Z][a-zA-Z0-9+.-]*)://';
const RE_DOMAIN = '^[a-zA-Z][a-zA-Z0-9+.-]*://(\\[[^\\]]*\\]|[^/?#:]*)';
const RE_PORT = '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:\\[[^\\]]*\\]|[^/?#:]*):([0-9]+)';
const RE_PATH_ABS = '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]*([^?#]*)';
const RE_PATH_REL = '^([^?#]*)';
const RE_QUERY = '^[^?#]*\\?([^#]*)';

const ALB_URL = reqLine('"request"', 2);

// type (1) is split: the scheme and the HTTP version come from the request line, so it is left
// with the transport it names. ip_address (34) is the load balancer node, i.e. the local end of
// both sockets; client (4) and target (5) are the two remote ends.
const ALB_OTEL: [string, string][] = [
  ['timestamp', `"time"`],
  ['client.address', addrOf(`"client_port"`)],
  ['client.port', portOf(`"client_port"`)],
  ['destination.address', addrOf(`"target_port"`)],
  ['destination.port', portOf(`"target_port"`)],
  ['network.local.address', `"ip_address"`],
  ['network.protocol.name', `CASE "type" WHEN 'grpcs' THEN 'grpc' WHEN 'ws' THEN 'websocket' WHEN 'wss' THEN 'websocket' WHEN 'http' THEN 'http' WHEN 'https' THEN 'http' WHEN 'h2' THEN 'http' END`],
  ['network.protocol.version', reqLine('"request"', 4)],
  ['http.request.method', reqLine('"request"', 1)],
  ['url.full', ALB_URL],
  ['url.scheme', urlPart(ALB_URL, RE_SCHEME)],
  ['url.domain', urlPart(ALB_URL, RE_DOMAIN)],
  ['url.port', `TRY_CAST(${urlPart(ALB_URL, RE_PORT)} AS INTEGER)`],
  ['url.path', urlPart(ALB_URL, RE_PATH_ABS)],
  ['url.query', urlPart(ALB_URL, RE_QUERY)],
  ['server.address', `"domain_name"`],
  ['http.response.status_code', `"elb_status_code"`],
  ['http.request.size', `"received_bytes"`],
  ['http.response.size', `"sent_bytes"`],
  ['user_agent.original', `"user_agent"`],
  ['error.type', `"error_reason"`],
  ['tls.cipher', `"ssl_cipher"`],
  ['tls.protocol.name', tlsName(`"ssl_protocol"`)],
  ['tls.protocol.version', tlsVersion(`"ssl_protocol"`)],
  ['aws.alb.type', `"type"`],
  ['aws.alb.id', `"elb"`],
  ['aws.alb.target_status_code', `"target_status_code"`],
  ['aws.alb.request_processing_time', `"request_processing_time"`],
  ['aws.alb.target_processing_time', `"target_processing_time"`],
  ['aws.alb.response_processing_time', `"response_processing_time"`],
  ['aws.alb.target_group.arn', `"target_group_arn"`],
  ['aws.alb.trace_id', `"trace_id"`],
  ['aws.alb.conn_trace_id', `"conn_trace_id"`],
  ['aws.alb.chosen_cert.arn', `"chosen_cert_arn"`],
  ['aws.alb.matched_rule_priority', `"matched_rule_priority"`],
  ['aws.alb.request_creation_time', `"request_creation_time"`],
  ['aws.alb.actions_executed', `"actions_executed"`],
  ['aws.alb.redirect_url', `"redirect_url"`],
  ['aws.alb.target_port_list', `"target_port_list"`],
  ['aws.alb.target_status_code_list', `"target_status_code_list"`],
  ['aws.alb.classification', `"classification"`],
  ['aws.alb.classification_reason', `"classification_reason"`],
  ['aws.alb.transformed_host', `"transformed_host"`],
  ['aws.alb.transformed_uri', `"transformed_uri"`],
  ['aws.alb.request_transform_status', `"request_transform_status"`],
];

// cs(Host) is the distribution's own domain and x-host-header the one the viewer asked for, so
// the second is server.address. sc-bytes counts the headers, sc-content-len does not.
const CLOUDFRONT_OTEL: [string, string][] = [
  ['timestamp', CLOUDFRONT_TIME],
  ['client.address', `"c_ip"`],
  ['client.port', `"c_port"`],
  ['server.address', `"x_host_header"`],
  ['network.protocol.name', `nullif(regexp_extract(lower("cs_protocol_version"), '^([a-z]+)/', 1), '')`],
  ['network.protocol.version', `nullif(regexp_extract("cs_protocol_version", '^[A-Za-z]+/([0-9.]+)$', 1), '')`],
  ['http.request.method', `"cs_method"`],
  ['url.scheme', `"cs_protocol"`],
  ['url.path', `"cs_uri_stem"`],
  ['url.query', `"cs_uri_query"`],
  ['http.response.status_code', `"sc_status"`],
  ['http.request.size', `"cs_bytes"`],
  ['http.response.size', `"sc_bytes"`],
  ['http.response.body.size', `"sc_content_len"`],
  ['http.request.header.referer', `"cs_referer"`],
  ['http.request.header.cookie', `"cs_cookie"`],
  ['http.request.header.x-forwarded-for', `"x_forwarded_for"`],
  ['http.response.header.content-type', `"sc_content_type"`],
  ['user_agent.original', `"cs_user_agent"`],
  ['tls.cipher', `"ssl_cipher"`],
  ['tls.protocol.name', tlsName(`"ssl_protocol"`)],
  ['tls.protocol.version', tlsVersion(`"ssl_protocol"`)],
  ['aws.request_id', `"x_edge_request_id"`],
  ['aws.cloudfront.domain', `"cs_host"`],
  ['aws.cloudfront.edge_location', `"x_edge_location"`],
  ['aws.cloudfront.result_type', `"x_edge_result_type"`],
  ['aws.cloudfront.response_result_type', `"x_edge_response_result_type"`],
  ['aws.cloudfront.detailed_result_type', `"x_edge_detailed_result_type"`],
  ['aws.cloudfront.time_taken', `"time_taken"`],
  ['aws.cloudfront.time_to_first_byte', `"time_to_first_byte"`],
  ['aws.cloudfront.fle_status', `"fle_status"`],
  ['aws.cloudfront.fle_encrypted_fields', `"fle_encrypted_fields"`],
  ['aws.cloudfront.range.start', `"sc_range_start"`],
  ['aws.cloudfront.range.end', `"sc_range_end"`],
];

const S3ACCESS_TARGET = reqLine('"request_uri"', 2);

// bytes_sent leaves out the response headers (body.size), while ALB's sent_bytes includes them.
const S3ACCESS_OTEL: [string, string][] = [
  ['timestamp', S3ACCESS_TIME],
  ['client.address', `"remote_ip"`],
  ['server.address', `"host_header"`],
  ['network.protocol.name', `lower(${reqLine('"request_uri"', 3)})`],
  ['network.protocol.version', reqLine('"request_uri"', 4)],
  ['http.request.method', reqLine('"request_uri"', 1)],
  ['url.path', urlPart(S3ACCESS_TARGET, RE_PATH_REL)],
  ['url.query', urlPart(S3ACCESS_TARGET, RE_QUERY)],
  ['http.response.status_code', `"http_status"`],
  ['http.response.body.size', `"bytes_sent"`],
  ['http.request.header.referer', `"referer"`],
  ['user_agent.original', `"user_agent"`],
  ['error.type', `"error_code"`],
  ['user.id', `"requester"`],
  ['tls.cipher', `"cipher_suite"`],
  ['tls.protocol.name', tlsName(`"tls_version"`)],
  ['tls.protocol.version', tlsVersion(`"tls_version"`)],
  ['aws.request_id', `"request_id"`],
  ['aws.extended_request_id', `"host_id"`],
  ['aws.s3.bucket', `"bucket"`],
  ['aws.s3.bucket_owner', `"bucket_owner"`],
  ['aws.s3.key', `"key"`],
  ['aws.s3.operation', `"operation"`],
  ['aws.s3.object_size', `"object_size"`],
  ['aws.s3.version_id', `"version_id"`],
  ['aws.s3.total_time', `"total_time"`],
  ['aws.s3.turn_around_time', `"turn_around_time"`],
  ['aws.s3.signature_version', `"signature_version"`],
  ['aws.s3.authentication_type', `"authentication_type"`],
  ['aws.s3.access_point_arn', `"access_point_arn"`],
  ['aws.s3.acl_required', `"acl_required"`],
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
    otel: ALB_OTEL,
    // NLB writes into the same folder with _net. in the name and has other columns entirely,
    // so the Application Load Balancer is recognised by _app. rather than by the folder
    detect: /\/elasticloadbalancing\/.*_app\./,
  },
  cloudfront: {
    id: 'cloudfront',
    reader: (l, f) => csvFixed(l, f, CLOUDFRONT_COLUMNS, `delim = '\t', quote = '', escape = '', skip = 2`),
    select: `, ${CLOUDFRONT_TIME} AS "timestamp"`,
    timeField: 'timestamp',
    otel: CLOUDFRONT_OTEL,
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
    select: `, ${S3ACCESS_TIME} AS "timestamp"`,
    timeField: 'timestamp',
    otel: S3ACCESS_OTEL,
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

/** Display name of a field naming in the UI language. */
export function namingLabel(id: Naming): string {
  return t(`naming.${id}`);
}

/** Display name of a format in the UI language. */
export function formatLabel(id: FormatId): string {
  return t(`fmt.${id}`);
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

/** Whether a format can be read under the OpenTelemetry names. */
export function hasOtel(fmt: FormatDef): boolean {
  return !!fmt.otel;
}

/** The preferred time field of a format, which the OTel projection renames to "timestamp". */
export function timeFieldFor(fmt: FormatDef, naming: Naming): string | undefined {
  return naming === 'otel' && fmt.otel ? 'timestamp' : fmt.timeField;
}

/** SELECT list of the OTel projection, or null for a format that has none (it is then read under its own names). */
export function otelSelect(fmt: FormatDef): string | null {
  return fmt.otel ? fmt.otel.map(([name, expr]) => `${expr} AS "${name}"`).join(', ') : null;
}

// ---------- Data source templates ----------

export type TemplateId =
  'alb' | 'alb-parquet' | 'nlb' | 'cloudfront' | 'cloudtrail' | 'flowlogs' | 'flowlogs-parquet' | 'waf' | 'netfw' | 'r53resolver' | 's3access' | 'firehose' | 'cwlexport' | 'ssm';

export interface Template {
  id: TemplateId;
  format: FormatId;
  /** pattern with <bucket> (and optional <prefix>) placeholders the user must replace */
  urls: string;
}

/** Display name / explanatory note of a template in the UI language (keys tpl.<id>.label / .note). */
export function templateLabel(tp: Template): string {
  return t(`tpl.${tp.id}.label`);
}
export function templateNote(tp: Template): string {
  return t(`tpl.${tp.id}.note`);
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
