import { type OtelByName, type FormatDef } from './types';
import { fn } from './shared';

const FLOWLOGS_OTEL: OtelByName = {
  prefix: 'aws.vpc.flow.',
  map: {
    start: [['timestamp', `to_timestamp(TRY_CAST({} AS BIGINT))::TIMESTAMP`]],
    end: [['aws.vpc.flow.end', `to_timestamp(TRY_CAST({} AS BIGINT))::TIMESTAMP`]],
    srcaddr: [['source.address']],
    dstaddr: [['destination.address']],
    srcport: [['source.port', `TRY_CAST({} AS INTEGER)`]],
    dstport: [['destination.port', `TRY_CAST({} AS INTEGER)`]],
    // the IANA number stays: it names protocols that network.transport has no value for
    protocol: [
      ['network.transport', `CASE TRY_CAST({} AS INTEGER) WHEN 1 THEN 'icmp' WHEN 6 THEN 'tcp' WHEN 17 THEN 'udp' WHEN 47 THEN 'gre' WHEN 58 THEN 'ipv6-icmp' WHEN 132 THEN 'sctp' END`],
      ['aws.vpc.flow.protocol'],
    ],
    // likewise EFA, which is neither of the two values network.type has
    type: [['network.type', `CASE lower({}) WHEN 'ipv4' THEN 'ipv4' WHEN 'ipv6' THEN 'ipv6' END`], ['aws.vpc.flow.type']],
    flow_direction: [['network.io.direction', `CASE lower({}) WHEN 'ingress' THEN 'receive' WHEN 'egress' THEN 'transmit' END`], ['aws.vpc.flow.flow_direction']],
    // an account id is an identifier, not a number, whatever the reader made of the digits
    account_id: [['cloud.account.id', `TRY_CAST({} AS VARCHAR)`]],
    region: [['cloud.region']],
    az_id: [['cloud.availability_zone']],
    instance_id: [['host.id']],
    ecs_cluster_arn: [['aws.ecs.cluster.arn']],
    ecs_task_arn: [['aws.ecs.task.arn']],
    ecs_task_id: [['aws.ecs.task.id']],
    ecs_container_instance_arn: [['aws.ecs.container.arn']],
  },
};

export const flowlogsFormat: FormatDef = {
  id: 'flowlogs',
  // every field of a flow log is "-" when it does not apply, so that is this format's null
  reader: (l, f) => `read_csv_auto(${l}, delim = ' ', header = true, nullstr = '-'${fn(f)})`,
  timeField: 'start',
  otelByName: FLOWLOGS_OTEL,
  detect: /\/vpcflowlogs\//,
};
