import { jcast, j, REC, fn, ctjson } from './shared';
import { type FormatDef } from './types';

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

export const cloudtrailFormat: FormatDef = {
  id: 'cloudtrail',
  reader: (l, f) => `read_json_auto(${l}, union_by_name = true, maximum_object_size = 268435456${fn(f)})`,
  // one row per Record; the filename (if requested) is carried along
  wrap: (inner) => `SELECT rec.*, * EXCLUDE (rec) FROM (SELECT unnest(Records) AS rec, * EXCLUDE (Records) FROM (${inner}))`,
  timeField: 'eventTime',
  otel: { columns: CLOUDTRAIL_OTEL, reader: ctjson },
  detect: /\/CloudTrail\//,
};
