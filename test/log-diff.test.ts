import { describe, expect, it } from 'vitest';
import { timeContext } from '../src/datemath';
import type { Field } from '../src/fields';
import { buildDiffQuery, defaultDiffField, diffDrillDown, diffErrorWhere } from '../src/logDiff';
import { compileSearch } from '../src/queryPlans';
import { DEFAULT_DISCOVER, DEFAULT_VIS, type DiffState, type SearchState } from '../src/state';
import { sanitizeDiscover } from '../src/stateCodec';
import { readUrlState, writeUrlState } from '../src/urlState';
import { restoreSearch } from '../src/stateCodec';

const field = (name: string, kind: Field['kind'] = 'string'): Field => ({
  name,
  expr: `"${name}"`,
  column: name,
  kind,
  duckType: kind === 'string' ? 'VARCHAR' : 'DOUBLE',
  searchable: kind === 'string',
});
const message = field('message');
const fields = [message, field('level'), field('http.path'), field('http.status', 'number')];
const settings: DiffState = { mode: 'patterns', field: null, errorsOnly: true, newOnly: false };
const search: SearchState = { query: 'level:error', range: { from: 'now-1h', to: 'now' }, filters: [] };
const context = timeContext(new Date('2026-09-22T02:00:00Z'));
const compiled = compileSearch(search, fields, '"ts"', context);

describe('difference analysis boundaries and persistence', () => {
  it('captures both periods on the search clock and preserves query filters', () => {
    const plan = buildDiffQuery(settings, message, fields, '"ts"', search, compiled)!;
    expect(plan.currentRange).toEqual({ from: '2026-09-22T01:00:00.000Z', to: '2026-09-22T02:00:00.000Z' });
    expect(plan.previousRange).toEqual({ from: '2026-09-22T00:00:00.000Z', to: '2026-09-22T01:00:00.000Z' });
    expect(plan.sql).toContain('error');
    expect(plan.sql).toContain('"ts" >= TIMESTAMP \'2026-09-22 01:00:00.000\' AS current_period');
  });

  it('requires a valid positive time window', () => {
    expect(buildDiffQuery(settings, message, fields, null, search, compiled)).toBeNull();
    expect(buildDiffQuery(settings, message, fields, '"ts"', search, { ...compiled, to: compiled.from })).toBeNull();
    expect(buildDiffQuery(settings, message, fields, '"ts"', search, { ...compiled, error: 'bad query' })).toBeNull();
  });

  it('drills into the identical grouping and error conditions, quoting untrusted values', () => {
    const plan = buildDiffQuery(settings, message, fields, '"ts"', search, compiled)!;
    const next = diffDrillDown(
      plan,
      { value: "user's error <n>", example: '', current: 3, previous: 0, delta: 3 },
      search,
    );
    expect(next.range).toEqual(plan.currentRange);
    expect(next.query).toBe(search.query);
    expect(next.filters[0].sql).toBe(`(${plan.groupExpr}) = 'user''s error <n>' AND (${plan.errorWhere})`);
    // An external copy remains subject to the existing custom SQL trust gate.
    expect(restoreSearch(next).filters[0].disabled).toBe(true);
  });

  it('chooses known message/URL fields and explicit error attributes before text heuristics', () => {
    expect(defaultDiffField(fields, 'patterns')).toBe(message);
    expect(defaultDiffField(fields, 'urls')?.name).toBe('http.path');
    expect(defaultDiffField([], 'urls')).toBeNull();
    expect(diffErrorWhere(fields, message)).toContain('BETWEEN 500 AND 599');
    expect(diffErrorWhere(fields, message)).not.toContain('regexp_matches');
    expect(diffErrorWhere([message], message)).toContain('timeout');
    expect(diffErrorWhere([field('severity_number', 'number')], message)).toContain('BETWEEN 17 AND 24');
  });

  it('uses the chosen message field for errors in unstructured logs', () => {
    const custom = field('custom_message');
    const customFields = [field('service'), custom];
    const customSearch = { ...search, query: '' };
    const customCompiled = compileSearch(customSearch, customFields, '"ts"', context);
    const plan = buildDiffQuery(settings, custom, customFields, '"ts"', customSearch, customCompiled)!;
    expect(plan.errorWhere).toContain('regexp_matches("custom_message"');
    expect(plan.errorWhere).not.toContain('"service"');
  });

  it('round-trips panel settings while malformed/old views remain usable', () => {
    const state = {
      page: 'discover' as const,
      search,
      vis: DEFAULT_VIS,
      discover: { ...DEFAULT_DISCOVER, diff: settings },
    };
    writeUrlState(state);
    expect(readUrlState()).toEqual(state);
    expect(sanitizeDiscover({ diff: 'bad' })).toEqual(DEFAULT_DISCOVER);
    expect(sanitizeDiscover({ diff: { mode: 'bad', field: 3, errorsOnly: 'false', newOnly: 'true' } }).diff).toEqual(
      settings,
    );
  });

  it('keeps totals when there are no increasing groups', () => {
    const plan = buildDiffQuery(settings, message, fields, '"ts"', search, compiled)!;
    expect(plan.read([{ current_total: 2, previous_total: 5, k: null, total_changes: null }])).toEqual({
      currentTotal: 2,
      previousTotal: 5,
      totalChanges: 0,
      rows: [],
    });
  });
});
