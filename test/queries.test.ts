import { describe, expect, it } from 'vitest';
import type { Field } from '../src/fields';
import { metricLabel, metricPlan } from '../src/queries';
import type { MetricDef } from '../src/state';

const f = (name: string, kind: Field['kind']): Field => ({ name, expr: `"${name}"`, kind, duckType: kind.toUpperCase(), column: name, searchable: kind === 'string' });
const fields = [f('ms', 'number'), f('host', 'string')];
const m = (patch: Partial<MetricDef>): MetricDef => ({ id: 'm0', agg: 'count', field: null, ...patch });

describe('metricPlan', () => {
  it('counts without reading a column', () => {
    expect(metricPlan(m({ agg: 'count' }), fields).input).toBeNull();
    expect(metricPlan(m({ agg: 'count' }), fields).agg('v0')).toBe('count(*)::DOUBLE');
  });

  it('divides a rate by the seconds of its bucket, and never by zero', () => {
    expect(metricPlan(m({ agg: 'rate' }), fields, 60).agg('v0')).toBe('(count(*)::DOUBLE / 60)');
    expect(metricPlan(m({ agg: 'rate' }), fields, 0).agg('v0')).toBe('(count(*)::DOUBLE / 1)');
  });

  it('casts a non-numeric column and takes a numeric one as it is', () => {
    expect(metricPlan(m({ agg: 'avg', field: 'ms' }), fields).input).toBe('"ms"');
    expect(metricPlan(m({ agg: 'avg', field: 'host' }), fields).input).toBe('TRY_CAST("host" AS DOUBLE)');
    // unique counts the values themselves, so it keeps the column
    expect(metricPlan(m({ agg: 'unique', field: 'host' }), fields).input).toBe('"host"');
    expect(metricPlan(m({ agg: 'unique', field: 'host' }), fields).agg('v0')).toBe('count(DISTINCT v0)::DOUBLE');
  });

  it('keeps a percentile inside 0–100 and expresses it as a fraction', () => {
    expect(metricPlan(m({ agg: 'percentile', field: 'ms', param: 95 }), fields).agg('v0')).toBe('quantile_cont(v0, 0.95)::DOUBLE');
    expect(metricPlan(m({ agg: 'percentile', field: 'ms', param: 150 }), fields).agg('v0')).toBe('quantile_cont(v0, 1)::DOUBLE');
    expect(metricPlan(m({ agg: 'percentile', field: 'ms', param: -5 }), fields).agg('v0')).toBe('quantile_cont(v0, 0)::DOUBLE');
    expect(metricPlan(m({ agg: 'percentile', field: 'ms' }), fields).agg('v0')).toBe('quantile_cont(v0, 0.9)::DOUBLE');
  });

  it('yields NULL for a field the source does not have', () => {
    expect(metricPlan(m({ agg: 'sum', field: 'nope' }), fields).agg('v0')).toBe('NULL::DOUBLE');
    expect(metricPlan(m({ agg: 'sum', field: null }), fields).agg('v0')).toBe('NULL::DOUBLE');
  });
});

describe('metricLabel', () => {
  it('prefers the label the user gave it', () => {
    expect(metricLabel(m({ agg: 'avg', field: 'ms', label: 'latency' }))).toBe('latency');
  });

  it('names the aggregation and the field otherwise', () => {
    expect(metricLabel(m({ agg: 'count' }))).toBe('Count of records');
    expect(metricLabel(m({ agg: 'avg', field: 'ms' }))).toContain('ms');
    expect(metricLabel(m({ agg: 'percentile', field: 'ms', param: 99 }))).toContain('99');
    expect(metricLabel(m({ agg: 'sum', field: null }))).toContain('?');
  });
});
