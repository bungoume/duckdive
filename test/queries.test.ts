import { describe, expect, it } from 'vitest';
import type { Field } from '../src/fields';
import { docsOrder, exportDocsSql } from '../src/queries';

const f = (name: string, kind: Field['kind']): Field => ({ name, expr: `"${name}"`, kind, duckType: kind.toUpperCase(), column: name, searchable: kind === 'string' });
const ts = f('ts', 'date');
const fields = [ts, f('status', 'number'), f('host', 'string')];
const timeExpr = '("ts")::TIMESTAMP';

describe('docsOrder', () => {
  it('sorts by the chosen fields, else newest first, else not at all', () => {
    expect(docsOrder([{ field: 'status', dir: 'asc' }], fields, timeExpr)).toBe(' ORDER BY "status" ASC NULLS LAST');
    expect(docsOrder([], fields, timeExpr)).toBe(` ORDER BY ${timeExpr} DESC NULLS LAST`);
    expect(docsOrder([{ field: 'nope', dir: 'asc' }], fields, null)).toBe('');
  });
});

describe('exportDocsSql', () => {
  it('exports every column when none is selected', () => {
    expect(exportDocsSql('TRUE', ts, timeExpr, fields, [], [], 10)).toBe(`SELECT * FROM src t WHERE TRUE ORDER BY ${timeExpr} DESC NULLS LAST LIMIT 10`);
  });

  it('exports the time column and the selected columns under their names', () => {
    expect(exportDocsSql('"status" = 500', ts, timeExpr, fields, [{ field: 'host', dir: 'desc' }], ['host', 'status'], 5.7)).toBe(
      `SELECT ${timeExpr} AS "ts", "host" AS "host", "status" AS "status" FROM src t WHERE "status" = 500 ORDER BY "host" DESC NULLS LAST LIMIT 5`,
    );
  });

  it('does not repeat a selected time field and never exports zero rows', () => {
    expect(exportDocsSql('TRUE', ts, timeExpr, fields, [], ['ts'], 0)).toBe(`SELECT "ts" AS "ts" FROM src t WHERE TRUE ORDER BY ${timeExpr} DESC NULLS LAST LIMIT 1`);
  });
});
