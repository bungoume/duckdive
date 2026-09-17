import { describe, expect, it } from 'vitest';
import { templateExpr, templateFilterSql, templateRegex } from '../src/patterns';

describe('log patterns', () => {
  it('nests one regexp_replace per mask, ids before numbers', () => {
    const e = templateExpr('"message"');
    expect(e.startsWith('regexp_replace(regexp_replace(regexp_replace(regexp_replace("message", \'[0-9a-fA-F]{8}-')).toBe(true);
    expect(e.endsWith("'<n>', 'g')")).toBe(true);
  });

  it('turns a template back into an anchored expression that matches its lines', () => {
    const re = new RegExp(templateRegex('slow request: GET /api/articles/<n> took <n>ms (client <ip>)'));
    expect(re.test('slow request: GET /api/articles/42 took 1200ms (client 10.0.0.7)')).toBe(true);
    expect(re.test('slow request: GET /api/articles/42 took 1200ms (client x)')).toBe(false);
    expect(re.test('route not found: /api/articles/42')).toBe(false);
    expect(templateFilterSql('"message"', 'a.b')).toBe(`regexp_matches("message", '^a\\.b$')`);
  });
});
