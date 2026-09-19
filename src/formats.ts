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

export type FormatId = 'auto' | 'parquet' | 'csv' | 'json' | 'alb' | 'cloudfront' | 'cloudtrail' | 'flowlogs' | 's3access' | 'waf' | 'r53resolver' | 'ltsv' | 'cwlexport' | 'lines';

/**
 * How a format is read under the OpenTelemetry names. `columns` is the whole projection, in
 * order. A projection that brings its own `reader` replaces the format's reader and its wrap:
 * the JSON families read the records as they are rather than through an inferred schema.
 */
export interface OtelProjection {
  columns: [string, string][];
  reader?: (list: string, withFilename: boolean) => string;
}

export interface FormatDef {
  id: FormatId;
  /** table function over the file list */
  reader: (list: string, withFilename: boolean) => string;
  /** star modifier for the reader's columns (starts with " REPLACE (") */
  replace?: string;
  /** extra SELECT expressions (start with ", ") */
  select?: string;
  /** wrap "SELECT … FROM reader" → e.g. unnest Records */
  wrap?: (inner: string) => string;
  /** preferred time field */
  timeField?: string;
  /** projection under the OpenTelemetry names; the time field is then "timestamp" */
  otel?: OtelProjection;
  /** detect from the first URL */
  detect?: RegExp;
}

const fn = (withFilename: boolean) => (withFilename ? ', filename = true' : '');

/**
 * A number the log leaves out is written as "-" in these layouts, and a column declared as a
 * number makes DuckDB fail the whole query on such a row. The error arrives when something reads
 * that column, so a source connects and then breaks on one row in the middle of a day. Numeric
 * columns are therefore read as text and cast back in the view: an unreadable number becomes
 * NULL, which is what Athena yields for the same file under the same declared types.
 */
const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|FLOAT|REAL|DOUBLE|DECIMAL)/;

function csvFixed(list: string, withFilename: boolean, columns: [string, string][], opts: string): string {
  const cols = '{' + columns.map(([n, t]) => `${lit(n)}: ${lit(NUMERIC.test(t) ? 'VARCHAR' : t)}`).join(', ') + '}';
  return `read_csv(${list}, ${opts}, header = false, auto_detect = false, null_padding = true, strict_mode = false, columns = ${cols}${fn(withFilename)})`;
}

/** The column at its declared type: a numeric one is read as text by csvFixed, so it is cast here. */
const typed =
  (columns: [string, string][]) =>
  (name: string): string => {
    const type = columns.find(([n]) => n === name)?.[1] ?? 'VARCHAR';
    return NUMERIC.test(type) ? `TRY_CAST("${name}" AS ${type})` : `"${name}"`;
  };

/** `* REPLACE (...)` that gives the numeric columns of a fixed layout their declared type back. */
function numericReplace(columns: [string, string][]): string {
  const cast = columns.filter(([, t]) => NUMERIC.test(t));
  return cast.length ? ` REPLACE (${cast.map(([n, t]) => `TRY_CAST("${n}" AS ${t}) AS "${n}"`).join(', ')})` : '';
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

const alb = typed(ALB_COLUMNS);
const cf = typed(CLOUDFRONT_COLUMNS);
const s3a = typed(S3ACCESS_COLUMNS);

const ALB_URL = reqLine(alb('request'), 2);

// type (1) is split: the scheme and the HTTP version come from the request line, so it is left
// with the transport it names. ip_address (34) is the load balancer node, i.e. the local end of
// both sockets; client (4) and target (5) are the two remote ends.
const ALB_OTEL: [string, string][] = [
  ['timestamp', alb('time')],
  ['client.address', addrOf(alb('client_port'))],
  ['client.port', portOf(alb('client_port'))],
  ['destination.address', addrOf(alb('target_port'))],
  ['destination.port', portOf(alb('target_port'))],
  ['network.local.address', alb('ip_address')],
  [
    'network.protocol.name',
    `CASE ${alb('type')} WHEN 'grpcs' THEN 'grpc' WHEN 'ws' THEN 'websocket' WHEN 'wss' THEN 'websocket' WHEN 'http' THEN 'http' WHEN 'https' THEN 'http' WHEN 'h2' THEN 'http' END`,
  ],
  ['network.protocol.version', reqLine(alb('request'), 4)],
  ['http.request.method', reqLine(alb('request'), 1)],
  ['url.full', ALB_URL],
  ['url.scheme', urlPart(ALB_URL, RE_SCHEME)],
  ['url.domain', urlPart(ALB_URL, RE_DOMAIN)],
  ['url.port', `TRY_CAST(${urlPart(ALB_URL, RE_PORT)} AS INTEGER)`],
  ['url.path', urlPart(ALB_URL, RE_PATH_ABS)],
  ['url.query', urlPart(ALB_URL, RE_QUERY)],
  ['server.address', alb('domain_name')],
  ['http.response.status_code', alb('elb_status_code')],
  ['http.request.size', alb('received_bytes')],
  ['http.response.size', alb('sent_bytes')],
  ['user_agent.original', alb('user_agent')],
  ['error.type', alb('error_reason')],
  ['tls.cipher', alb('ssl_cipher')],
  ['tls.protocol.name', tlsName(alb('ssl_protocol'))],
  ['tls.protocol.version', tlsVersion(alb('ssl_protocol'))],
  ['aws.alb.type', alb('type')],
  ['aws.alb.id', alb('elb')],
  ['aws.alb.target_status_code', alb('target_status_code')],
  ['aws.alb.request_processing_time', alb('request_processing_time')],
  ['aws.alb.target_processing_time', alb('target_processing_time')],
  ['aws.alb.response_processing_time', alb('response_processing_time')],
  ['aws.alb.target_group.arn', alb('target_group_arn')],
  ['aws.alb.trace_id', alb('trace_id')],
  ['aws.alb.conn_trace_id', alb('conn_trace_id')],
  ['aws.alb.chosen_cert.arn', alb('chosen_cert_arn')],
  ['aws.alb.matched_rule_priority', alb('matched_rule_priority')],
  ['aws.alb.request_creation_time', alb('request_creation_time')],
  ['aws.alb.actions_executed', alb('actions_executed')],
  ['aws.alb.redirect_url', alb('redirect_url')],
  ['aws.alb.target_port_list', alb('target_port_list')],
  ['aws.alb.target_status_code_list', alb('target_status_code_list')],
  ['aws.alb.classification', alb('classification')],
  ['aws.alb.classification_reason', alb('classification_reason')],
  ['aws.alb.transformed_host', alb('transformed_host')],
  ['aws.alb.transformed_uri', alb('transformed_uri')],
  ['aws.alb.request_transform_status', alb('request_transform_status')],
];

// cs(Host) is the distribution's own domain and x-host-header the one the viewer asked for, so
// the second is server.address. sc-bytes counts the headers, sc-content-len does not.
const CLOUDFRONT_OTEL: [string, string][] = [
  ['timestamp', CLOUDFRONT_TIME],
  ['client.address', cf('c_ip')],
  ['client.port', cf('c_port')],
  ['server.address', cf('x_host_header')],
  ['network.protocol.name', `nullif(regexp_extract(lower(${cf('cs_protocol_version')}), '^([a-z]+)/', 1), '')`],
  ['network.protocol.version', `nullif(regexp_extract(${cf('cs_protocol_version')}, '^[A-Za-z]+/([0-9.]+)$', 1), '')`],
  ['http.request.method', cf('cs_method')],
  ['url.scheme', cf('cs_protocol')],
  ['url.path', cf('cs_uri_stem')],
  ['url.query', cf('cs_uri_query')],
  ['http.response.status_code', cf('sc_status')],
  ['http.request.size', cf('cs_bytes')],
  ['http.response.size', cf('sc_bytes')],
  ['http.response.body.size', cf('sc_content_len')],
  ['http.request.header.referer', cf('cs_referer')],
  ['http.request.header.cookie', cf('cs_cookie')],
  ['http.request.header.x-forwarded-for', cf('x_forwarded_for')],
  ['http.response.header.content-type', cf('sc_content_type')],
  ['user_agent.original', cf('cs_user_agent')],
  ['tls.cipher', cf('ssl_cipher')],
  ['tls.protocol.name', tlsName(cf('ssl_protocol'))],
  ['tls.protocol.version', tlsVersion(cf('ssl_protocol'))],
  ['aws.request_id', cf('x_edge_request_id')],
  ['aws.cloudfront.domain', cf('cs_host')],
  ['aws.cloudfront.edge_location', cf('x_edge_location')],
  ['aws.cloudfront.result_type', cf('x_edge_result_type')],
  ['aws.cloudfront.response_result_type', cf('x_edge_response_result_type')],
  ['aws.cloudfront.detailed_result_type', cf('x_edge_detailed_result_type')],
  ['aws.cloudfront.time_taken', cf('time_taken')],
  ['aws.cloudfront.time_to_first_byte', cf('time_to_first_byte')],
  ['aws.cloudfront.fle_status', cf('fle_status')],
  ['aws.cloudfront.fle_encrypted_fields', cf('fle_encrypted_fields')],
  ['aws.cloudfront.range.start', cf('sc_range_start')],
  ['aws.cloudfront.range.end', cf('sc_range_end')],
];

const S3ACCESS_TARGET = reqLine(s3a('request_uri'), 2);

// bytes_sent leaves out the response headers (body.size), while ALB's sent_bytes includes them.
const S3ACCESS_OTEL: [string, string][] = [
  ['timestamp', S3ACCESS_TIME],
  ['client.address', s3a('remote_ip')],
  ['server.address', s3a('host_header')],
  ['network.protocol.name', `lower(${reqLine(s3a('request_uri'), 3)})`],
  ['network.protocol.version', reqLine(s3a('request_uri'), 4)],
  ['http.request.method', reqLine(s3a('request_uri'), 1)],
  ['url.path', urlPart(S3ACCESS_TARGET, RE_PATH_REL)],
  ['url.query', urlPart(S3ACCESS_TARGET, RE_QUERY)],
  ['http.response.status_code', s3a('http_status')],
  ['http.response.body.size', s3a('bytes_sent')],
  ['http.request.header.referer', s3a('referer')],
  ['user_agent.original', s3a('user_agent')],
  ['error.type', s3a('error_code')],
  ['user.id', s3a('requester')],
  ['tls.cipher', s3a('cipher_suite')],
  ['tls.protocol.name', tlsName(s3a('tls_version'))],
  ['tls.protocol.version', tlsVersion(s3a('tls_version'))],
  ['aws.request_id', s3a('request_id')],
  ['aws.extended_request_id', s3a('host_id')],
  ['aws.s3.bucket', s3a('bucket')],
  ['aws.s3.bucket_owner', s3a('bucket_owner')],
  ['aws.s3.key', s3a('key')],
  ['aws.s3.operation', s3a('operation')],
  ['aws.s3.object_size', s3a('object_size')],
  ['aws.s3.version_id', s3a('version_id')],
  ['aws.s3.total_time', s3a('total_time')],
  ['aws.s3.turn_around_time', s3a('turn_around_time')],
  ['aws.s3.signature_version', s3a('signature_version')],
  ['aws.s3.authentication_type', s3a('authentication_type')],
  ['aws.s3.access_point_arn', s3a('access_point_arn')],
  ['aws.s3.acl_required', s3a('acl_required')],
];

// ---- JSON log families ----
//
// A JSON layout has no column list to project: the keys differ between records and between
// files, and a path that is missing from one file would make the view fail to bind. Under the
// OTel naming these formats therefore read the records as they are (read_json_objects) and pull
// each attribute out by path, which is NULL when a record does not carry it. Nothing is lost:
// `body` keeps the whole record, and the field sidebar expands its keys like any JSON column.

/** The record column of the JSON readers below. */
const REC = '"rec"';
/** A path of the record as text; a record without it yields NULL. */
const j = (path: string) => `json_extract_string(${REC}, '$.${path}')`;
/** … as a number, a boolean, or the JSON value itself. */
const jcast = (path: string, type: string) => `TRY_CAST(${j(path)} AS ${type})`;
const jraw = (path: string) => `json_extract(${REC}, '$.${path}')`;

/** One record per line, as written (WAF, Route 53 Resolver, Cloud Logging, Logpush). */
const ndjson = (l: string, f: boolean) => `(SELECT "json" AS rec${f ? ', filename' : ''} FROM read_json_objects(${l}${fn(f)}))`;
/** CloudTrail delivers {"Records":[ … ]}: one row per element, without inferring their shape. */
const ctjson = (l: string, f: boolean) => `(SELECT unnest(json_extract("json", '$.Records')::JSON[]) AS rec${f ? ', filename' : ''} FROM read_json_objects(${l}${fn(f)}))`;

/** "HTTP/2.0" → "http" / "2.0", for the layouts that log the protocol that way. */
const protoName = (e: string) => `nullif(regexp_extract(lower(${e}), '^([a-z]+)/', 1), '')`;
const protoVersion = (e: string) => `nullif(regexp_extract(${e}, '^[A-Za-z]+/([0-9.]+)$', 1), '')`;

const CLOUDTRAIL_OTEL: [string, string][] = [
  ['timestamp', jcast('eventTime', 'TIMESTAMP')],
  ['client.address', j('sourceIPAddress')],
  ['user_agent.original', j('userAgent')],
  ['user.id', j('userIdentity.arn')],
  ['user.name', j('userIdentity.userName')],
  ['cloud.region', j('awsRegion')],
  ['cloud.account.id', j('recipientAccountId')],
  ['error.type', j('errorCode')],
  ['aws.request_id', j('requestID')],
  ['log.record.uid', j('eventID')],
  ['aws.cloudtrail.event_source', j('eventSource')],
  ['aws.cloudtrail.event_name', j('eventName')],
  ['aws.cloudtrail.event_type', j('eventType')],
  ['aws.cloudtrail.event_category', j('eventCategory')],
  ['aws.cloudtrail.error_message', j('errorMessage')],
  ['aws.cloudtrail.read_only', jcast('readOnly', 'BOOLEAN')],
  ['aws.cloudtrail.management_event', jcast('managementEvent', 'BOOLEAN')],
  ['aws.cloudtrail.shared_event_id', j('sharedEventID')],
  ['aws.cloudtrail.vpc_endpoint_id', j('vpcEndpointId')],
  ['aws.cloudtrail.user_identity.type', j('userIdentity.type')],
  ['aws.cloudtrail.user_identity.account_id', j('userIdentity.accountId')],
  ['aws.cloudtrail.user_identity.principal_id', j('userIdentity.principalId')],
  ['aws.cloudtrail.user_identity.session_issuer_arn', j('userIdentity.sessionContext.sessionIssuer.arn')],
  ['body', REC],
];

const WAF_OTEL: [string, string][] = [
  ['timestamp', `epoch_ms(${jcast('timestamp', 'BIGINT')})`],
  ['client.address', j('httpRequest.clientIp')],
  ['http.request.method', j('httpRequest.httpMethod')],
  ['url.path', j('httpRequest.uri')],
  ['url.query', j('httpRequest.args')],
  ['network.protocol.name', protoName(j('httpRequest.httpVersion'))],
  ['network.protocol.version', protoVersion(j('httpRequest.httpVersion'))],
  ['aws.request_id', j('httpRequest.requestId')],
  ['aws.waf.action', j('action')],
  ['aws.waf.terminating_rule_id', j('terminatingRuleId')],
  ['aws.waf.terminating_rule_type', j('terminatingRuleType')],
  ['aws.waf.web_acl_id', j('webaclId')],
  ['aws.waf.source_name', j('httpSourceName')],
  ['aws.waf.source_id', j('httpSourceId')],
  ['aws.waf.country', j('httpRequest.country')],
  ['aws.waf.ja3_fingerprint', j('ja3Fingerprint')],
  ['aws.waf.response_code_sent', jcast('responseCodeSent', 'INTEGER')],
  ['aws.waf.labels', jraw('labels')],
  ['body', REC],
];

const R53RESOLVER_OTEL: [string, string][] = [
  ['timestamp', jcast('query_timestamp', 'TIMESTAMP')],
  ['client.address', j('srcaddr')],
  ['client.port', jcast('srcport', 'INTEGER')],
  ['network.transport', `nullif(regexp_extract(lower(${j('transport')}), '^(tcp|udp)', 1), '')`],
  ['dns.question.name', j('query_name')],
  ['dns.answers', jraw('answers[*].Rdata')],
  ['cloud.account.id', j('account_id')],
  ['cloud.region', j('region')],
  ['host.id', j('srcids.instance')],
  ['aws.route53.query_type', j('query_type')],
  ['aws.route53.query_class', j('query_class')],
  ['aws.route53.rcode', j('rcode')],
  ['aws.route53.vpc_id', j('vpc_id')],
  ['aws.route53.resolver_endpoint_id', j('srcids.resolver_endpoint')],
  ['aws.route53.firewall_rule_action', j('firewall_rule_action')],
  ['aws.route53.firewall_rule_group_id', j('firewall_rule_group_id')],
  ['aws.route53.firewall_domain_list_id', j('firewall_domain_list_id')],
  ['body', REC],
];

const LTSV_EXPR = `to_json(map_from_entries(list_transform(string_split(line, chr(9)), x -> struct_pack(key := split_part(x, ':', 1), value := x[length(split_part(x, ':', 1)) + 2:]))))`;

export const FORMATS: Record<Exclude<FormatId, 'auto'>, FormatDef> = {
  parquet: { id: 'parquet', reader: (l, f) => `read_parquet(${l}${fn(f)})` },
  csv: { id: 'csv', reader: (l, f) => `read_csv_auto(${l}${fn(f)})`, detect: /\.(csv|tsv|log|txt)(\.gz|\.zst)?$/ },
  json: {
    id: 'json',
    reader: (l, f) => `read_json_auto(${l}, union_by_name = true${fn(f)})`,
    // by extension, or by the delivery paths of AWS services that write JSON lines as *.log.gz
    detect: /\.(json|jsonl|ndjson)(\.gz|\.zst)?$|\/network-firewall\//,
  },
  alb: {
    id: 'alb',
    reader: (l, f) => csvFixed(l, f, ALB_COLUMNS, `delim = ' ', quote = '"', escape = '"', timestampformat = '%Y-%m-%dT%H:%M:%S.%fZ'`),
    replace: numericReplace(ALB_COLUMNS),
    timeField: 'time',
    otel: { columns: ALB_OTEL },
    // NLB writes into the same folder with _net. in the name and has other columns entirely,
    // so the Application Load Balancer is recognised by _app. rather than by the folder
    detect: /\/elasticloadbalancing\/.*_app\./,
  },
  cloudfront: {
    id: 'cloudfront',
    reader: (l, f) => csvFixed(l, f, CLOUDFRONT_COLUMNS, `delim = '\t', quote = '', escape = '', skip = 2`),
    replace: numericReplace(CLOUDFRONT_COLUMNS),
    select: `, ${CLOUDFRONT_TIME} AS "timestamp"`,
    timeField: 'timestamp',
    otel: { columns: CLOUDFRONT_OTEL },
    detect: /[A-Z0-9]{13,14}\.\d{4}-\d{2}-\d{2}-\d{2}\.[^/]+\.gz$/,
  },
  cloudtrail: {
    id: 'cloudtrail',
    reader: (l, f) => `read_json_auto(${l}, union_by_name = true, maximum_object_size = 268435456${fn(f)})`,
    // one row per Record; the filename (if requested) is carried along
    wrap: (inner) => `SELECT rec.*, * EXCLUDE (rec) FROM (SELECT unnest(Records) AS rec, * EXCLUDE (Records) FROM (${inner}))`,
    timeField: 'eventTime',
    otel: { columns: CLOUDTRAIL_OTEL, reader: ctjson },
    detect: /\/CloudTrail\//,
  },
  waf: {
    id: 'waf',
    reader: (l, f) => `read_json_auto(${l}, union_by_name = true${fn(f)})`,
    timeField: 'timestamp',
    otel: { columns: WAF_OTEL, reader: ndjson },
    detect: /\/WAFLogs\//,
  },
  r53resolver: {
    id: 'r53resolver',
    reader: (l, f) => `read_json_auto(${l}, union_by_name = true${fn(f)})`,
    timeField: 'query_timestamp',
    otel: { columns: R53RESOLVER_OTEL, reader: ndjson },
    detect: /\/vpcdnsquerylogs\//,
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
    replace: numericReplace(S3ACCESS_COLUMNS),
    select: `, ${S3ACCESS_TIME} AS "timestamp"`,
    timeField: 'timestamp',
    otel: { columns: S3ACCESS_OTEL },
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

export const FORMAT_IDS: FormatId[] = ['auto', 'parquet', 'csv', 'json', 'alb', 'cloudfront', 'cloudtrail', 'flowlogs', 's3access', 'waf', 'r53resolver', 'ltsv', 'cwlexport', 'lines'];

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
  return !!fmt.otel;
}

/** The preferred time field of a format, which the OTel projection renames to "timestamp". */
export function timeFieldFor(fmt: FormatDef, naming: Naming): string | undefined {
  return naming === 'otel' && fmt.otel ? 'timestamp' : fmt.timeField;
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
    format: 'waf',
    urls: 's3://<bucket>/AWSLogs/{account}/WAFLogs/{region}/{webacl}/{yyyy}/{MM}/{dd}/{HH}/*/{account}_waflogs_{region}_{webacl}_*.log.gz',
  },
  {
    id: 'netfw',
    format: 'json',
    urls: 's3://<bucket>/AWSLogs/{account}/network-firewall/{log_type}/{region}/{firewall}/{yyyy}/{MM}/{dd}/{HH}/*.log.gz',
  },
  {
    id: 'r53resolver',
    format: 'r53resolver',
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
