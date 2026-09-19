import { query } from './duck';
import { lit } from './sql';

export type FieldKind = 'string' | 'number' | 'date' | 'boolean' | 'object' | 'list' | 'json' | 'unknown';

export interface Field {
  /** Display name, dotted for nested fields (e.g. "geo.country"). */
  name: string;
  /** SQL expression yielding the value. */
  expr: string;
  kind: FieldKind;
  duckType: string;
  /** Parent column name (top-level). */
  column: string;
  /** Whether this field is included in free-text search. */
  searchable: boolean;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function kindOf(duckType: string): FieldKind {
  const t = duckType.toUpperCase();
  if (t.startsWith('STRUCT')) return 'object';
  if (t.startsWith('MAP')) return 'object';
  if (t.startsWith('UNION')) return 'object';
  if (t.endsWith('[]') || t.startsWith('LIST') || t.startsWith('ARRAY')) return 'list';
  if (t === 'JSON') return 'json';
  if (t === 'VARCHAR' || t === 'TEXT' || t === 'STRING' || t === 'UUID' || t.startsWith('ENUM') || t === 'CHAR' || t.startsWith('VARCHAR(')) return 'string';
  if (t === 'BOOLEAN' || t === 'BOOL') return 'boolean';
  if (t.startsWith('TIMESTAMP') || t === 'DATE' || t === 'DATETIME') return 'date';
  if (/^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)/.test(t)) return 'number';
  return 'unknown';
}

/** Parse a DuckDB STRUCT type string into [name, type] pairs. */
export function parseStructType(t: string): [string, string][] | null {
  const m = /^STRUCT\((.*)\)$/s.exec(t.trim());
  if (!m) return null;
  const body = m[1];
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQuote) {
      cur += ch;
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuote = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      cur += ch;
    } else if (ch === '(') {
      depth++;
      cur += ch;
    } else if (ch === ')') {
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  const out: [string, string][] = [];
  for (const p of parts) {
    let name: string;
    let rest: string;
    if (p.startsWith('"')) {
      let j = 1;
      let n = '';
      while (j < p.length) {
        if (p[j] === '"') {
          if (p[j + 1] === '"') {
            n += '"';
            j += 2;
            continue;
          }
          break;
        }
        n += p[j++];
      }
      name = n;
      rest = p.slice(j + 1).trim();
    } else {
      const sp = p.indexOf(' ');
      name = p.slice(0, sp);
      rest = p.slice(sp + 1).trim();
    }
    out.push([name, rest]);
  }
  return out;
}

function expandStruct(prefixName: string, prefixExpr: string, column: string, duckType: string, depth: number, out: Field[]) {
  const members = parseStructType(duckType);
  if (!members || depth > 4) return;
  for (const [name, type] of members) {
    const fname = `${prefixName}.${name}`;
    const expr = `${prefixExpr}.${quoteIdent(name)}`;
    const kind = kindOf(type);
    out.push({ name: fname, expr, kind, duckType: type, column, searchable: kind === 'string' });
    if (kind === 'object') expandStruct(fname, expr, column, type, depth + 1, out);
  }
}

/**
 * JSON columns: sample keys to expose sub-fields of object columns. This runs at connect time and
 * reads data (up to 500 non-null values), so for JSON-typed columns over HTTP a connect is not
 * listing-only; fixed layouts without JSON columns keep that guarantee.
 */
async function expandJson(view: string, col: string, out: Field[]) {
  const expr = quoteIdent(col);
  try {
    const r = await query(
      `WITH s AS (SELECT ${expr} AS j FROM ${view} WHERE ${expr} IS NOT NULL LIMIT 500),
       k AS (SELECT unnest(json_keys(j)) AS k, j FROM s WHERE json_type(j) = 'OBJECT')
       SELECT k, mode(json_type(j, '$.' || k)) AS t FROM k GROUP BY k ORDER BY k LIMIT 200`,
    );
    for (const row of r.rows) {
      const k = String(row.k);
      const jt = String(row.t ?? '');
      const path = `'$.${k.replace(/'/g, "''")}'`;
      let kind: FieldKind = 'string';
      let fexpr = `json_extract_string(${expr}, ${path})`;
      let duckType = 'JSON:' + jt;
      if (jt === 'UBIGINT' || jt === 'BIGINT' || jt === 'DOUBLE' || jt === 'HUGEINT') {
        kind = 'number';
        fexpr = `TRY_CAST(json_extract(${expr}, ${path}) AS DOUBLE)`;
      } else if (jt === 'BOOLEAN') {
        kind = 'boolean';
        fexpr = `TRY_CAST(json_extract(${expr}, ${path}) AS BOOLEAN)`;
      } else if (jt === 'OBJECT') {
        kind = 'object';
        duckType = 'JSON';
        fexpr = `json_extract(${expr}, ${path})`;
      } else if (jt === 'ARRAY') {
        kind = 'list';
        fexpr = `json_extract(${expr}, ${path})::VARCHAR`;
      }
      out.push({ name: `${col}.${k}`, expr: fexpr, kind, duckType, column: col, searchable: kind === 'string' });
    }
  } catch {
    /* ignore: json extension might be unavailable */
  }
}

/**
 * Columns of `view`. Read from the catalog (duckdb_columns) rather than with DESCRIBE: the
 * view's types were resolved when it was created, and DESCRIBE would bind the view again,
 * which for remote files means another round of HEAD / footer requests.
 */
export async function introspectFields(view: string): Promise<Field[]> {
  const r = await query(`SELECT column_name, data_type FROM duckdb_columns() WHERE table_name = ${lit(view)} AND schema_name = current_schema() ORDER BY column_index`);
  const out: Field[] = [];
  for (const row of r.rows) {
    const col = String(row.column_name);
    const type = String(row.data_type);
    const kind = kindOf(type);
    const expr = quoteIdent(col);
    out.push({ name: col, expr, kind, duckType: type, column: col, searchable: kind === 'string' || kind === 'json' || kind === 'list' });
    if (kind === 'object') expandStruct(col, expr, col, type, 0, out);
    else if (kind === 'json') await expandJson(view, col, out);
  }
  return out;
}

export function findField(fields: Field[], name: string): Field | undefined {
  return fields.find((f) => f.name === name) ?? fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
}

/** SQL expression that turns a field into a naive UTC TIMESTAMP, for use as the time field. */
export function timeExprFor(f: Field): string {
  const t = f.duckType.toUpperCase();
  if (t.startsWith('TIMESTAMP WITH TIME ZONE') || t === 'TIMESTAMPTZ') return `(${f.expr})::TIMESTAMP`;
  if (t.startsWith('TIMESTAMP')) return `(${f.expr})::TIMESTAMP`;
  if (t === 'DATE') return `(${f.expr})::TIMESTAMP`;
  if (f.kind === 'number') {
    // Heuristic: epoch seconds vs milliseconds vs microseconds is decided by magnitude.
    return `CASE WHEN ${f.expr} > 1e15 THEN make_timestamp((${f.expr})::BIGINT) WHEN ${f.expr} > 1e11 THEN epoch_ms((${f.expr})::BIGINT) ELSE to_timestamp((${f.expr})::DOUBLE)::TIMESTAMP END`;
  }
  // strings: ISO 8601, "10/Sep/2026:12:00:00 +0900" (nginx / apache, with or without brackets), epoch digits
  const e = f.expr;
  return `coalesce(TRY_CAST(${e} AS TIMESTAMPTZ)::TIMESTAMP, try_strptime(${e}, '[%d/%b/%Y:%H:%M:%S %z]')::TIMESTAMP, try_strptime(${e}, '%d/%b/%Y:%H:%M:%S %z')::TIMESTAMP, try_strptime(${e}, '%d/%b/%Y:%H:%M:%S')::TIMESTAMP, CASE WHEN regexp_matches(${e}, '^\\d{9,10}(\\.\\d+)?$') THEN to_timestamp(TRY_CAST(${e} AS DOUBLE))::TIMESTAMP WHEN regexp_matches(${e}, '^\\d{13}$') THEN epoch_ms(TRY_CAST(${e} AS BIGINT)) END)`;
}

export function isTimeCandidate(f: Field): boolean {
  if (f.kind === 'date') return true;
  const n = f.name.toLowerCase();
  if (n === 'start' || n === 'end') return f.kind === 'number';
  return (f.kind === 'number' || f.kind === 'string') && /(^|[_.])(ts|time|timestamp|date|datetime|created|updated|@timestamp|eventtime)(_at|_ms|_us|_ns)?$/.test(n);
}
