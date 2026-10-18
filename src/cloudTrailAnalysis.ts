import { findField, type Field } from './fields';
import type { Compiled, QueryPlan } from './queryPlans';
import { lit, newId, VIEW, type Filter } from './sql';

export interface CloudTrailTemplate {
  id: 'cloudtrail';
  source: Field;
  name: Field;
  eventType: Field;
  errorCode?: Field;
  errorMessage?: Field;
  arn?: Field;
  principal?: Field;
  userName?: Field;
  account?: Field;
  identityType?: Field;
}

export function cloudTrailTemplateFor(fields: Field[]): CloudTrailTemplate | null {
  for (const otel of [false, true]) {
    const find = (native: string, normalized: string) => findField(fields, otel ? normalized : native);
    const source = find('eventSource', 'aws.cloudtrail.event_source');
    const name = find('eventName', 'aws.cloudtrail.event_name');
    const eventType = find('eventType', 'aws.cloudtrail.event_type');
    if (source?.kind !== 'string' || name?.kind !== 'string' || eventType?.kind !== 'string') continue;
    return {
      id: 'cloudtrail',
      source,
      name,
      eventType,
      errorCode: find('errorCode', 'error.type'),
      errorMessage: find('errorMessage', 'aws.cloudtrail.error_message'),
      arn: find('userIdentity.arn', 'user.id'),
      principal: find('userIdentity.principalId', 'aws.cloudtrail.user_identity.principal_id'),
      userName: find('userIdentity.userName', 'user.name'),
      account: find('userIdentity.accountId', 'aws.cloudtrail.user_identity.account_id'),
      identityType: find('userIdentity.type', 'aws.cloudtrail.user_identity.type'),
    };
  }
  return null;
}

function textExpr(field: Field | undefined): string {
  return field?.kind === 'string' ? `nullif(trim(${field.expr}), '')` : 'NULL::VARCHAR';
}
export function trailEligibleExpr(template: CloudTrailTemplate): string {
  return `${template.eventType.expr} = 'AwsApiCall'`;
}
export function trailErrorExpr(template: CloudTrailTemplate): string {
  return `(${textExpr(template.errorCode)} IS NOT NULL OR ${textExpr(template.errorMessage)} IS NOT NULL)`;
}
/** Prefer the caller ARN (including assumed-role sessions), then an account-qualified identifier. */
export function trailUserExpr(template: CloudTrailTemplate): string {
  return `coalesce(${textExpr(template.arn)},
    coalesce(${textExpr(template.account)}, '?') || ' / ' || coalesce(${textExpr(template.principal)}, ${textExpr(template.userName)}))`;
}

export type TrailCategory = 'permissions' | 'credentials' | 'audit' | 'network' | 'root';
/** Explicit service/API pairs: similarly named operations in other services must not match. */
const IMPORTANT: { category: TrailCategory; source: string; names: string[] }[] = [
  {
    category: 'permissions',
    source: 'iam.amazonaws.com',
    names: [
      'AttachUserPolicy',
      'AttachGroupPolicy',
      'AttachRolePolicy',
      'DetachUserPolicy',
      'DetachGroupPolicy',
      'DetachRolePolicy',
      'PutUserPolicy',
      'PutGroupPolicy',
      'PutRolePolicy',
      'DeleteUserPolicy',
      'DeleteGroupPolicy',
      'DeleteRolePolicy',
      'CreatePolicy',
      'DeletePolicy',
      'CreatePolicyVersion',
      'DeletePolicyVersion',
      'SetDefaultPolicyVersion',
      'UpdateAssumeRolePolicy',
      'AddUserToGroup',
      'RemoveUserFromGroup',
      'PutUserPermissionsBoundary',
      'PutRolePermissionsBoundary',
      'DeleteUserPermissionsBoundary',
      'DeleteRolePermissionsBoundary',
    ],
  },
  {
    category: 'permissions',
    source: 'kms.amazonaws.com',
    names: ['PutKeyPolicy', 'CreateGrant', 'RevokeGrant', 'RetireGrant'],
  },
  {
    category: 'credentials',
    source: 'iam.amazonaws.com',
    names: [
      'CreateAccessKey',
      'UpdateAccessKey',
      'DeleteAccessKey',
      'CreateLoginProfile',
      'UpdateLoginProfile',
      'DeleteLoginProfile',
      'ChangePassword',
      'EnableMFADevice',
      'DeactivateMFADevice',
      'DeleteVirtualMFADevice',
      'UpdateAccountPasswordPolicy',
      'DeleteAccountPasswordPolicy',
    ],
  },
  {
    category: 'audit',
    source: 'cloudtrail.amazonaws.com',
    names: [
      'StopLogging',
      'DeleteTrail',
      'UpdateTrail',
      'PutEventSelectors',
      'StopEventDataStoreIngestion',
      'DeleteEventDataStore',
      'UpdateEventDataStore',
    ],
  },
  {
    category: 'network',
    source: 'ec2.amazonaws.com',
    names: [
      'AuthorizeSecurityGroupIngress',
      'AuthorizeSecurityGroupEgress',
      'RevokeSecurityGroupIngress',
      'RevokeSecurityGroupEgress',
      'ModifySecurityGroupRules',
      'CreateNetworkAclEntry',
      'ReplaceNetworkAclEntry',
      'DeleteNetworkAclEntry',
    ],
  },
];
export function trailCategoryExpr(template: CloudTrailTemplate): string {
  const cases = IMPORTANT.map(
    ({ category, source, names }) =>
      `WHEN ${textExpr(template.source)} = ${lit(source)} AND ${textExpr(template.name)} IN (${names.map(lit).join(', ')}) THEN ${lit(category)}`,
  );
  // Each API record contributes once. Other root API calls form their own group.
  return `CASE ${cases.join(' ')} WHEN ${textExpr(template.identityType)} = 'Root' THEN 'root' END`;
}

export type TrailGroupKind = 'user' | 'api' | 'important';
export interface TrailGroup {
  kind: TrailGroupKind;
  user: string | null;
  source: string | null;
  name: string | null;
  category: TrailCategory | null;
  calls: number;
  errors: number;
}
export interface TrailAnalysis {
  total: number;
  calls: number;
  errors: number;
  errorRate: number | null;
  important: number;
  excluded: number;
  groups: TrailGroup[];
}

export function buildTrailAnalysisQuery(template: CloudTrailTemplate, compiled: Compiled): QueryPlan<TrailAnalysis> {
  const aggregate = `count(*)::DOUBLE AS calls, count(*) FILTER (WHERE failed)::DOUBLE AS errors`;
  const rank =
    'ORDER BY calls DESC, errors DESC, actor ASC NULLS LAST, source ASC NULLS LAST, name ASC NULLS LAST, category ASC NULLS LAST LIMIT 10';
  const sql = `WITH trail_base AS MATERIALIZED (
    SELECT (${trailEligibleExpr(template)}) AS eligible, ${trailErrorExpr(template)} AS failed,
      ${trailUserExpr(template)} AS actor, ${textExpr(template.source)} AS source, ${textExpr(template.name)} AS name,
      ${trailCategoryExpr(template)} AS category
    FROM ${VIEW} WHERE ${compiled.where}
  ), calls AS (SELECT * FROM trail_base WHERE eligible), summary AS (
    SELECT ${aggregate}, count(*) FILTER (WHERE category IS NOT NULL)::DOUBLE AS important FROM calls
  ), coverage AS (SELECT count(*)::DOUBLE AS total FROM trail_base), users AS (
    SELECT 'user' AS kind, actor, NULL::VARCHAR AS source, NULL::VARCHAR AS name, NULL::VARCHAR AS category, ${aggregate}
    FROM calls GROUP BY actor ${rank}
  ), apis AS (
    SELECT 'api' AS kind, NULL::VARCHAR AS actor, source, name, NULL::VARCHAR AS category, ${aggregate}
    FROM calls GROUP BY source, name ${rank}
  ), important_ops AS (
    SELECT 'important' AS kind, NULL::VARCHAR AS actor, source, name, category, ${aggregate}
    FROM calls WHERE category IS NOT NULL GROUP BY source, name, category ${rank}
  ), trail_rankings AS (SELECT * FROM users UNION ALL SELECT * FROM apis UNION ALL SELECT * FROM important_ops)
  SELECT summary.*, coverage.total, r.kind, r.actor, r.source, r.name, r.category, r.calls AS group_calls, r.errors AS group_errors
  FROM summary CROSS JOIN coverage LEFT JOIN trail_rankings r ON TRUE
  ORDER BY r.kind, r.calls DESC, r.errors DESC, r.actor ASC NULLS LAST, r.source ASC NULLS LAST, r.name ASC NULLS LAST, r.category ASC NULLS LAST`;
  return {
    sql,
    read(rows) {
      const first = rows[0];
      const total = Number(first?.total ?? 0);
      const calls = Number(first?.calls ?? 0);
      const errors = Number(first?.errors ?? 0);
      const text = (value: unknown) => (value == null ? null : String(value));
      return {
        total,
        calls,
        errors,
        errorRate: calls ? (errors / calls) * 100 : null,
        important: Number(first?.important ?? 0),
        excluded: total - calls,
        groups: rows
          .filter((r) => r.kind != null)
          .map((r) => ({
            kind: String(r.kind) as TrailGroupKind,
            user: text(r.actor),
            source: text(r.source),
            name: text(r.name),
            category: text(r.category) as TrailCategory | null,
            calls: Number(r.group_calls),
            errors: Number(r.group_errors),
          })),
      };
    },
  };
}

export function trailLogsFilter(
  template: CloudTrailTemplate,
  label: string,
  options: { group?: TrailGroup; errors?: boolean; important?: boolean } = {},
): Filter {
  const clauses = [`(${trailEligibleExpr(template)})`];
  const { group } = options;
  if (options.errors) clauses.push(trailErrorExpr(template));
  if (options.important) clauses.push(`(${trailCategoryExpr(template)}) IS NOT NULL`);
  const equal = (expr: string, value: string | null) =>
    `(${expr}) IS NOT DISTINCT FROM ${value === null ? 'NULL' : lit(value)}`;
  if (group?.kind === 'user') clauses.push(equal(trailUserExpr(template), group.user));
  if (group?.kind === 'api' || group?.kind === 'important') {
    clauses.push(equal(textExpr(template.source), group.source), equal(textExpr(template.name), group.name));
    if (group.kind === 'important') clauses.push(equal(trailCategoryExpr(template), group.category));
  }
  return { id: newId(), field: '', op: 'query', label, sql: clauses.join(' AND ') };
}
