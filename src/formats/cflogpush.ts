import {
  j,
  jcast,
  protoName,
  protoVersion,
  urlPart,
  RE_PATH_REL,
  RE_QUERY,
  tlsName,
  tlsVersion,
  REC,
  readJson,
  ndjson,
} from './shared';
import { type FormatDef } from './types';

// ---- Cloudflare Logpush (HTTP requests) ----
//
// The fields of a Logpush job are chosen when the job is created, so a given bucket holds only
// some of these; the ones that were not selected are NULL. EdgeStartTimestamp is RFC 3339 or
// Unix nanoseconds depending on the job, and both are read.

const cfTime = (path: string) =>
  `coalesce(TRY_CAST(${j(path)} AS TIMESTAMP), make_timestamp(TRY_CAST(${j(path)} AS BIGINT) // 1000))`;

const CF_URI = j('ClientRequestURI');

const CFLOGPUSH_OTEL: [string, string][] = [
  ['timestamp', cfTime('EdgeStartTimestamp')],
  ['client.address', j('ClientIP')],
  ['client.port', jcast('ClientSrcPort', 'INTEGER')],
  ['destination.address', j('OriginIP')],
  ['server.address', j('ClientRequestHost')],
  ['network.protocol.name', protoName(j('ClientRequestProtocol'))],
  ['network.protocol.version', protoVersion(j('ClientRequestProtocol'))],
  ['http.request.method', j('ClientRequestMethod')],
  ['url.scheme', j('ClientRequestScheme')],
  ['url.original', CF_URI],
  ['url.path', `coalesce(${j('ClientRequestPath')}, ${urlPart(CF_URI, RE_PATH_REL)})`],
  ['url.query', urlPart(CF_URI, RE_QUERY)],
  ['http.response.status_code', jcast('EdgeResponseStatus', 'INTEGER')],
  ['http.request.size', jcast('ClientRequestBytes', 'BIGINT')],
  ['http.response.size', jcast('EdgeResponseBytes', 'BIGINT')],
  ['http.response.body.size', jcast('EdgeResponseBodyBytes', 'BIGINT')],
  ['http.request.header.referer', j('ClientRequestReferer')],
  ['http.response.header.content-type', j('EdgeResponseContentType')],
  ['user_agent.original', j('ClientRequestUserAgent')],
  ['tls.cipher', j('ClientSSLCipher')],
  ['tls.protocol.name', tlsName(j('ClientSSLProtocol'))],
  ['tls.protocol.version', tlsVersion(j('ClientSSLProtocol'))],
  ['cloud.provider', `'cloudflare'`],
  ['cloudflare.ray_id', j('RayID')],
  ['cloudflare.cache_status', j('CacheCacheStatus')],
  ['cloudflare.origin_response_status', jcast('OriginResponseStatus', 'INTEGER')],
  ['cloudflare.client_country', j('ClientCountry')],
  ['cloudflare.client_asn', jcast('ClientASN', 'BIGINT')],
  ['cloudflare.security_action', j('SecurityAction')],
  ['cloudflare.edge_pathing_status', j('EdgePathingStatus')],
  ['cloudflare.edge_time_to_first_byte_ms', jcast('EdgeTimeToFirstByteMs', 'BIGINT')],
  ['cloudflare.edge_end_timestamp', cfTime('EdgeEndTimestamp')],
  ['body', REC],
];

export const cflogpushFormat: FormatDef = {
  id: 'cflogpush',
  reader: readJson,
  timeField: 'EdgeStartTimestamp',
  otel: { columns: CFLOGPUSH_OTEL, reader: ndjson },
};
