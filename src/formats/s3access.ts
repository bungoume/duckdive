import { typed, reqLine, urlPart, RE_PATH_REL, RE_QUERY, tlsName, tlsVersion, csvFixed, numericReplace } from './shared';
import { type FormatDef } from './types';

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

const S3ACCESS_TIME = `try_strptime("time1"[2:] || ' ' || "time2"[:-2], '%d/%b/%Y:%H:%M:%S %z')::TIMESTAMP`;

const s3a = typed(S3ACCESS_COLUMNS);

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

export const s3accessFormat: FormatDef = {
  id: 's3access',
  reader: (l, f) => csvFixed(l, f, S3ACCESS_COLUMNS, `delim = ' ', quote = '"', escape = '"'`),
  replace: numericReplace(S3ACCESS_COLUMNS),
  select: `, ${S3ACCESS_TIME} AS "timestamp"`,
  timeField: 'timestamp',
  otel: { columns: S3ACCESS_OTEL },
  detect: /\/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[A-F0-9]{16}$/,
};
