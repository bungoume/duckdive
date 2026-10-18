import { describe, expect, it } from 'vitest';
import { analysisSearch, analysisTemplateFor } from '../src/analysisTemplates';
import { buildTrailAnalysisQuery, trailLogsFilter, type TrailGroup } from '../src/cloudTrailAnalysis';
import { timeContext } from '../src/datemath';
import type { Field } from '../src/fields';
import { compileSearch, docsOrder } from '../src/queryPlans';
import { restoreSearch } from '../src/stateCodec';

const field = (name: string, kind: Field['kind'] = 'string'): Field => ({
  name,
  column: name,
  expr: `"${name}"`,
  kind,
  duckType: 'VARCHAR',
  searchable: true,
});
const native = [
  'eventSource',
  'eventName',
  'eventType',
  'userIdentity.arn',
  'userIdentity.accountId',
  'userIdentity.principalId',
  'userIdentity.userName',
  'userIdentity.type',
  'errorCode',
  'errorMessage',
].map((n) => field(n));
const otel = [
  'aws.cloudtrail.event_source',
  'aws.cloudtrail.event_name',
  'aws.cloudtrail.event_type',
  'user.id',
  'user.name',
  'aws.cloudtrail.user_identity.type',
  'error.type',
  'aws.cloudtrail.error_message',
].map((n) => field(n));
const templateFor = (fields = native) => {
  const template = analysisTemplateFor(fields);
  if (template?.id !== 'cloudtrail') throw new Error('Expected CloudTrail template');
  return template;
};
const search = { query: 'eventSource:iam.amazonaws.com', filters: [], range: { from: 'now-1h', to: 'now' } };
const compiled = compileSearch(search, native, '"eventTime"', timeContext(new Date('2026-09-22T12:00:00Z')));
const group: TrailGroup = {
  kind: 'api',
  source: 'iam.amazonaws.com',
  name: 'AttachRolePolicy',
  user: null,
  category: null,
  calls: 3,
  errors: 1,
};

describe('CloudTrail analysis', () => {
  it('recognizes native, OTel and converted schemas without requiring optional error or identity fields', () => {
    expect(templateFor().id).toBe('cloudtrail');
    expect(templateFor(otel).errorCode?.name).toBe('error.type');
    expect(templateFor(native.slice(0, 3)).arn).toBeUndefined();
    expect(templateFor(native.slice(0, 3)).errorCode).toBeUndefined();
    expect(analysisTemplateFor(native.filter((f) => f.name !== 'eventType'))).toBeNull();
    expect(analysisTemplateFor(native.map((f) => (f.name === 'eventSource' ? field(f.name, 'object') : f)))).toBeNull();
    expect(analysisTemplateFor([field('status'), field('eventName')])).toBeNull();
  });
  it('shares one search-constrained scan and limits each ranking independently', () => {
    const plan = buildTrailAnalysisQuery(templateFor(), compiled);
    expect(plan.sql.match(/FROM src/g)).toHaveLength(1);
    expect(plan.sql).toContain(`WHERE ${compiled.where}`);
    expect(plan.sql.match(/LIMIT 10/g)).toHaveLength(3);
  });
  it('retains the API denominator, excluded events, and unavailable versus zero error rates', () => {
    const plan = buildTrailAnalysisQuery(templateFor(), compiled);
    expect(plan.read([{ total: 20, calls: 16, errors: 4, important: 7 }])).toEqual({
      total: 20,
      calls: 16,
      errors: 4,
      errorRate: 25,
      important: 7,
      excluded: 4,
      groups: [],
    });
    expect(plan.read([])).toMatchObject({ errorRate: null, calls: 0, groups: [] });
    expect(plan.read([{ total: 2, calls: 0 }])).toMatchObject({ errorRate: null, excluded: 2 });
    expect(plan.read([{ total: 2, calls: 2, errors: 0 }])).toMatchObject({ errorRate: 0, excluded: 0 });
  });
  it('keeps service and API together and uses the same category when drilling into important operations', () => {
    const filter = trailLogsFilter(templateFor(), 'permissions', {
      group: { ...group, kind: 'important', category: 'permissions' },
      errors: true,
    });
    expect(filter.sql).toContain("IS NOT DISTINCT FROM 'iam.amazonaws.com'");
    expect(filter.sql).toContain("IS NOT DISTINCT FROM 'AttachRolePolicy'");
    expect(filter.sql).toContain("IS NOT DISTINCT FROM 'permissions'");
    expect(filter.sql).toContain('"eventType" = \'AwsApiCall\'');
    expect(filter.sql).toContain('trim("errorCode")');
    expect(filter.sql).toContain('trim("errorMessage")');
  });
  it('escapes quoted identities and keeps unknown groups addressable while preserving the search', () => {
    const filter = trailLogsFilter(templateFor(), 'user', {
      group: { ...group, kind: 'user', user: "111 / o'connor" },
    });
    expect(filter.sql).toContain("'111 / o''connor'");
    expect(trailLogsFilter(templateFor(), 'unknown', { group: { ...group, kind: 'user', user: null } }).sql).toContain(
      'IS NOT DISTINCT FROM NULL',
    );
    const next = analysisSearch(search, compiled, filter);
    expect(next.query).toBe(search.query);
    expect(next.range).toEqual({ from: '2026-09-22T11:00:00.000Z', to: '2026-09-22T12:00:00.000Z' });
    expect(restoreSearch(next).filters[0].disabled).toBe(true);
    expect(docsOrder([{ field: 'eventName', dir: 'asc' }], native, null)).toBe(' ORDER BY "eventName" ASC NULLS LAST');
  });
});
