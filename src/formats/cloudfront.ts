import { typed, tlsName, tlsVersion, csvFixed, numericReplace } from './shared';
import { type FormatDef } from './types';

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

// ---- Derived timestamps, shared by the native `select` and the OTel projection ----
const CLOUDFRONT_TIME = `("date" || ' ' || "time")::TIMESTAMP`;

const cf = typed(CLOUDFRONT_COLUMNS);

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

export const cloudfrontFormat: FormatDef = {
  id: 'cloudfront',
  reader: (l, f) => csvFixed(l, f, CLOUDFRONT_COLUMNS, `delim = '\t', quote = '', escape = '', skip = 2`),
  replace: numericReplace(CLOUDFRONT_COLUMNS),
  select: `, ${CLOUDFRONT_TIME} AS "timestamp"`,
  timeField: 'timestamp',
  otel: { columns: CLOUDFRONT_OTEL },
  detect: /[A-Z0-9]{13,14}\.\d{4}-\d{2}-\d{2}-\d{2}\.[^/]+\.gz$/,
};
