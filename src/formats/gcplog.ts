import { j, jcast, protoName, protoVersion, urlPart, RE_SCHEME, RE_DOMAIN, RE_PORT, RE_PATH_ABS, RE_QUERY, jraw, REC, readJson, ndjson } from './shared';
import { type FormatDef } from './types';

// ---- Google Cloud Logging ----
//
// A LogEntry is an envelope around a payload, so `body` is the payload the entry carries and
// `log.record.original` the entry itself; the two together lose nothing. Severity is the one
// place where a value is translated: the conventions number the levels, Cloud Logging names them.

const GCP_SEVERITY = `CASE upper(${j('severity')}) WHEN 'DEBUG' THEN 5 WHEN 'INFO' THEN 9 WHEN 'NOTICE' THEN 10 WHEN 'WARNING' THEN 13 WHEN 'ERROR' THEN 17 WHEN 'CRITICAL' THEN 21 WHEN 'ALERT' THEN 22 WHEN 'EMERGENCY' THEN 23 END`;

const GCP_URL = j('httpRequest.requestUrl');

const GCPLOG_OTEL: [string, string][] = [
  ['timestamp', jcast('timestamp', 'TIMESTAMP')],
  ['observed_timestamp', jcast('receiveTimestamp', 'TIMESTAMP')],
  ['severity_text', j('severity')],
  ['severity_number', GCP_SEVERITY],
  // "projects/<project>/traces/<32 hex>" carries the trace id of the W3C context
  ['trace_id', `nullif(regexp_extract(${j('trace')}, '([0-9a-fA-F]{32})$', 1), '')`],
  ['span_id', j('spanId')],
  ['log.record.uid', j('insertId')],
  ['client.address', j('httpRequest.remoteIp')],
  ['network.local.address', j('httpRequest.serverIp')],
  ['network.protocol.name', protoName(j('httpRequest.protocol'))],
  ['network.protocol.version', protoVersion(j('httpRequest.protocol'))],
  ['http.request.method', j('httpRequest.requestMethod')],
  ['url.full', GCP_URL],
  ['url.scheme', urlPart(GCP_URL, RE_SCHEME)],
  ['server.address', urlPart(GCP_URL, RE_DOMAIN)],
  ['url.port', `TRY_CAST(${urlPart(GCP_URL, RE_PORT)} AS INTEGER)`],
  ['url.path', urlPart(GCP_URL, RE_PATH_ABS)],
  ['url.query', urlPart(GCP_URL, RE_QUERY)],
  ['http.response.status_code', jcast('httpRequest.status', 'INTEGER')],
  ['http.request.size', jcast('httpRequest.requestSize', 'BIGINT')],
  ['http.response.size', jcast('httpRequest.responseSize', 'BIGINT')],
  ['http.request.header.referer', j('httpRequest.referer')],
  ['user_agent.original', j('httpRequest.userAgent')],
  ['cloud.provider', `'gcp'`],
  ['cloud.account.id', j('resource.labels.project_id')],
  ['cloud.region', `coalesce(${j('resource.labels.region')}, ${j('resource.labels.location')})`],
  ['cloud.availability_zone', j('resource.labels.zone')],
  ['gcp.log_name', j('logName')],
  ['gcp.resource.type', j('resource.type')],
  ['gcp.resource.labels', jraw('resource.labels')],
  ['gcp.labels', jraw('labels')],
  ['gcp.operation.id', j('operation.id')],
  ['gcp.http_request.latency', j('httpRequest.latency')],
  ['gcp.http_request.cache_hit', jcast('httpRequest.cacheHit', 'BOOLEAN')],
  ['gcp.http_request.cache_lookup', jcast('httpRequest.cacheLookup', 'BOOLEAN')],
  ['gcp.source_location', jraw('sourceLocation')],
  ['body', `coalesce(${jraw('jsonPayload')}, ${jraw('protoPayload')}, ${jraw('textPayload')})`],
  ['log.record.original', REC],
];

export const gcplogFormat: FormatDef = {
  id: 'gcplog',
  reader: readJson,
  timeField: 'timestamp',
  otel: { columns: GCPLOG_OTEL, reader: ndjson },
};
