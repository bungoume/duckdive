import { jcast, j, jraw, REC, readJson, ndjson } from './shared';
import { type FormatDef } from './types';

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

export const r53resolverFormat: FormatDef = {
  id: 'r53resolver',
  reader: readJson,
  timeField: 'query_timestamp',
  otel: { columns: R53RESOLVER_OTEL, reader: ndjson },
  detect: /\/vpcdnsquerylogs\//,
};
