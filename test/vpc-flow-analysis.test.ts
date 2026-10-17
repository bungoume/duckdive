import { describe, expect, it } from 'vitest';
import { analysisSearch, analysisTemplateFor } from '../src/analysisTemplates';
import { timeContext } from '../src/datemath';
import type { Field } from '../src/fields';
import { compileSearch, docsOrder } from '../src/queryPlans';
import { restoreSearch } from '../src/stateCodec';
import { buildFlowAnalysisQuery, flowLogsFilter, type FlowGroup } from '../src/vpcFlowAnalysis';

const field = (name: string, kind: Field['kind'] = 'string'): Field => ({
  name,
  column: name,
  expr: `"${name}"`,
  kind,
  duckType: kind === 'number' ? 'BIGINT' : 'VARCHAR',
  searchable: kind === 'string',
});
const native = ['action', 'srcaddr', 'dstaddr', 'log-status']
  .map((n) => field(n))
  .concat(['bytes', 'packets', 'dstport', 'protocol'].map((n) => field(n, 'number')));
const otel = ['aws.vpc.flow.action', 'source.address', 'destination.address', 'aws.vpc.flow.log_status']
  .map((n) => field(n))
  .concat(
    ['aws.vpc.flow.bytes', 'aws.vpc.flow.packets', 'destination.port', 'aws.vpc.flow.protocol'].map((n) =>
      field(n, 'number'),
    ),
  );
const templateFor = (fields = native) => {
  const template = analysisTemplateFor(fields);
  if (template?.id !== 'vpcflow') throw new Error('Expected a VPC template');
  return template;
};
const search = { query: 'action:REJECT', filters: [], range: { from: 'now-1h', to: 'now' } };
const compiled = compileSearch(search, native, '"start"', timeContext(new Date('2026-09-22T12:00:00Z')));
const group: FlowGroup = {
  kind: 'port',
  address: null,
  protocol: 6,
  port: 443,
  bytes: 2000,
  packets: 2,
  records: 4,
  accepted: 3,
  rejected: 1,
  measured: 4,
};

describe('VPC Flow Logs analysis', () => {
  it('detects native, Parquet names, OpenTelemetry and converted string counters', () => {
    expect(templateFor().id).toBe('vpcflow');
    expect(templateFor(otel).bytes.name).toBe('aws.vpc.flow.bytes');
    expect(templateFor(native.map((f) => (f.name === 'log-status' ? field('log_status') : f))).logStatus?.name).toBe(
      'log_status',
    );
    expect(templateFor(native.map((f) => ({ ...f, kind: 'string' }))).bytes.kind).toBe('string');
    expect(analysisTemplateFor(native.filter((f) => f.name !== 'log-status'))).toBeNull();
    expect(analysisTemplateFor(native.filter((f) => f.name !== 'dstport'))).toBeNull();
    const custom = native.filter((f) => f.name !== 'log-status' && f.name !== 'packets').concat(field('interface-id'));
    expect(templateFor(custom).logStatus).toBeUndefined();
    expect(templateFor(custom).packets).toBeUndefined();
  });
  it('shares one constrained source scan across the summary and independent rankings', () => {
    const plan = buildFlowAnalysisQuery(templateFor(), compiled);
    expect(plan.sql.match(/FROM src/g)).toHaveLength(1);
    expect(plan.sql).toContain(`WHERE ${compiled.where}`);
    expect(plan.sql.match(/LIMIT 10/g)).toHaveLength(3);
  });
  it('computes a record-based REJECT rate and preserves missing volume versus measured zero', () => {
    const plan = buildFlowAnalysisQuery(templateFor(), compiled);
    expect(
      plan.read([
        {
          total: 16,
          records: 11,
          accepted: 8,
          rejected: 3,
          no_data: 1,
          skip_data: 1,
          bytes: 31400,
          packets: 314,
          measured: 8,
        },
      ]),
    ).toEqual({
      total: 16,
      records: 11,
      accepted: 8,
      rejected: 3,
      rejectRate: (3 / 11) * 100,
      excluded: 5,
      noData: 1,
      skipData: 1,
      bytes: 31400,
      packets: 314,
      measured: 8,
      groups: [],
    });
    expect(plan.read([])).toMatchObject({ rejectRate: null, bytes: null, packets: null, groups: [] });
    expect(plan.read([{ total: 1, records: 1, rejected: 0, bytes: 0, packets: 0, measured: 1 }])).toMatchObject({
      rejectRate: 0,
      bytes: 0,
      packets: 0,
    });
    expect(plan.read([{ total: 3, records: 0, no_data: 1, skip_data: 2 }])).toMatchObject({
      rejectRate: null,
      bytes: null,
      excluded: 3,
    });
  });
  it('keeps port and protocol together, including unknown values and the valid port zero', () => {
    const template = templateFor();
    const tcp = flowLogsFilter(template, 'tcp', group);
    const udp = flowLogsFilter(template, 'udp', { ...group, protocol: 17 });
    expect(tcp.sql).toContain('IS NOT DISTINCT FROM 443');
    expect(tcp.sql).toContain('IS NOT DISTINCT FROM 6');
    expect(udp.sql).toContain('IS NOT DISTINCT FROM 17');
    expect(flowLogsFilter(template, 'unknown', { ...group, port: null, protocol: null }).sql).toMatch(
      /IS NOT DISTINCT FROM NULL/,
    );
    expect(flowLogsFilter(template, 'zero', { ...group, port: 0 }).sql).toContain('IS NOT DISTINCT FROM 0');
  });
  it('drills into the exact source and eligibility, escaping addresses and preserving the analyzed search', () => {
    const filter = flowLogsFilter(templateFor(), 'source', { ...group, kind: 'source', address: "odd'address" }, true);
    expect(filter.sql).toContain("'odd''address'");
    expect(filter.sql).toContain('"srcaddr"');
    expect(filter.sql).toContain('"log-status" = \'OK\'');
    expect(filter.sql).toContain('"action" = \'REJECT\'');
    const next = analysisSearch(search, compiled, filter);
    expect(next.query).toBe(search.query);
    expect(next.range).toEqual({ from: '2026-09-22T11:00:00.000Z', to: '2026-09-22T12:00:00.000Z' });
    expect(restoreSearch(next).filters[0].disabled).toBe(true);
  });
  it('sorts converted byte strings numerically and leaves unrelated sorts alone', () => {
    const fields = native.map((f) => ({ ...f, kind: 'string' as const }));
    expect(docsOrder([{ field: 'bytes', dir: 'desc' }], fields, null)).toContain('TRY_CAST("bytes" AS DOUBLE)');
    expect(docsOrder([{ field: 'srcaddr', dir: 'asc' }], fields, null)).toBe(' ORDER BY "srcaddr" ASC NULLS LAST');
  });
});
