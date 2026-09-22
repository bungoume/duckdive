import { type FormatId } from './formats/types';
import { t } from './i18n';

// ---------- Data source templates ----------

export type TemplateId =
  | 'alb'
  | 'alb-parquet'
  | 'nlb'
  | 'cloudfront'
  | 'cloudtrail'
  | 'flowlogs'
  | 'flowlogs-parquet'
  | 'waf'
  | 'netfw'
  | 'r53resolver'
  | 's3access'
  | 'firehose'
  | 'gcplog'
  | 'cflogpush'
  | 'cwlexport'
  | 'ssm';

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
    id: 'gcplog',
    format: 'gcplog',
    urls: 's3://<bucket>/<log-id>/{yyyy}/{MM}/{dd}/*.json',
  },
  {
    id: 'cflogpush',
    format: 'cflogpush',
    urls: 's3://<bucket>/<prefix>/{yyyy}{MM}{dd}/*.log.gz',
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
