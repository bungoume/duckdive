import { jcast, j, protoName, protoVersion, jraw, REC, readJson, ndjson } from './shared';
import { type FormatDef } from './types';

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

export const wafFormat: FormatDef = {
  id: 'waf',
  reader: readJson,
  timeField: 'timestamp',
  otel: { columns: WAF_OTEL, reader: ndjson },
  detect: /\/WAFLogs\//,
};
