import { lit } from '../sql';
import { type FormatDef } from './types';

export const fn = (withFilename: boolean) => (withFilename ? ', filename = true' : '');

/**
 * A number the log leaves out is written as "-" in these layouts, and a column declared as a
 * number makes DuckDB fail the whole query on such a row. The error arrives when something reads
 * that column, so a source connects and then breaks on one row in the middle of a day. Numeric
 * columns are therefore read as text and cast back in the view: an unreadable number becomes
 * NULL, which is what Athena yields for the same file under the same declared types.
 */
export const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|FLOAT|REAL|DOUBLE|DECIMAL)/;

export function csvFixed(list: string, withFilename: boolean, columns: [string, string][], opts: string): string {
  const cols = '{' + columns.map(([n, t]) => `${lit(n)}: ${lit(NUMERIC.test(t) ? 'VARCHAR' : t)}`).join(', ') + '}';
  return `read_csv(${list}, ${opts}, header = false, auto_detect = false, null_padding = true, strict_mode = false, columns = ${cols}${fn(withFilename)})`;
}

/** The column at its declared type: a numeric one is read as text by csvFixed, so it is cast here. */
export const typed =
  (columns: [string, string][]) =>
  (name: string): string => {
    const type = columns.find(([n]) => n === name)?.[1] ?? 'VARCHAR';
    return NUMERIC.test(type) ? `TRY_CAST("${name}" AS ${type})` : `"${name}"`;
  };

/** `* REPLACE (...)` that gives the numeric columns of a fixed layout their declared type back. */
export function numericReplace(columns: [string, string][]): string {
  const cast = columns.filter(([, t]) => NUMERIC.test(t));
  return cast.length ? ` REPLACE (${cast.map(([n, t]) => `TRY_CAST("${n}" AS ${t}) AS "${n}"`).join(', ')})` : '';
}

/** "host:port" → the address; split at the last colon so an IPv6 address survives. A value that is not host:port ("-") is kept as it is. */
export const addrOf = (c: string) => `coalesce(nullif(regexp_extract(${c}, '^(.*):[0-9]+$', 1), ''), ${c})`;

export const portOf = (c: string) => `TRY_CAST(nullif(regexp_extract(${c}, '^.*:([0-9]+)$', 1), '') AS INTEGER)`;

/** "TLSv1.2" → "tls" / "1.2"; anything else, "-" included, is NULL. */
export const tlsName = (c: string) => `nullif(regexp_extract(lower(${c}), '^(tls|ssl)', 1), '')`;

export const tlsVersion = (c: string) => `nullif(regexp_extract(${c}, '^[A-Za-z]+v?([0-9][0-9.]*)$', 1), '')`;

/** Request line "GET <target> HTTP/1.1": 1 = method, 2 = target, 3 = protocol name, 4 = version. A malformed line ("- - -") gives NULL. */
export const reqLine = (c: string, g: 1 | 2 | 3 | 4) =>
  `nullif(regexp_extract(${c}, '^([A-Z]+) (\\S+) ([A-Za-z]+)/([0-9.]+)$', ${g}), '')`;

/** One part of the URL in `u`, NULL when the URL has no such part. */
export const urlPart = (u: string, re: string) => `nullif(regexp_extract(${u}, '${re}', 1), '')`;

export const RE_SCHEME = '^([a-zA-Z][a-zA-Z0-9+.-]*)://';

export const RE_DOMAIN = '^[a-zA-Z][a-zA-Z0-9+.-]*://(\\[[^\\]]*\\]|[^/?#:]*)';

export const RE_PORT = '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:\\[[^\\]]*\\]|[^/?#:]*):([0-9]+)';

export const RE_PATH_ABS = '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]*([^?#]*)';

export const RE_PATH_REL = '^([^?#]*)';

export const RE_QUERY = '^[^?#]*\\?([^#]*)';

// ---- JSON log families ----
//
// A JSON layout has no column list to project: the keys differ between records and between
// files, and a path that is missing from one file would make the view fail to bind. Under the
// OTel naming these formats therefore read the records as they are (read_json_objects) and pull
// each attribute out by path, which is NULL when a record does not carry it. Nothing is lost:
// `body` keeps the whole record, and the field sidebar expands its keys like any JSON column.

/** The record column of the JSON readers below. */
export const REC = '"rec"';

/** A path of the record as text; a record without it yields NULL. */
export const j = (path: string) => `json_extract_string(${REC}, '$.${path}')`;

/** … as a number, a boolean, or the JSON value itself. */
export const jcast = (path: string, type: string) => `TRY_CAST(${j(path)} AS ${type})`;

export const jraw = (path: string) => `json_extract(${REC}, '$.${path}')`;

/** One record per line, as written (WAF, Route 53 Resolver, Cloud Logging, Logpush). */
export const ndjson = (l: string, f: boolean) =>
  `(SELECT "json" AS rec${f ? ', filename' : ''} FROM read_json_objects(${l}${fn(f)}))`;

/** CloudTrail delivers {"Records":[ … ]}: one row per element, without inferring their shape. */
export const ctjson = (l: string, f: boolean) =>
  `(SELECT unnest(json_extract("json", '$.Records')::JSON[]) AS rec${f ? ', filename' : ''} FROM read_json_objects(${l}${fn(f)}))`;

/** "HTTP/2.0" → "http" / "2.0", for the layouts that log the protocol that way. */
export const protoName = (e: string) => `nullif(regexp_extract(lower(${e}), '^([a-z]+)/', 1), '')`;

export const protoVersion = (e: string) => `nullif(regexp_extract(${e}, '^[A-Za-z]+/([0-9.]+)$', 1), '')`;

export const readJson: FormatDef['reader'] = (l, f) => `read_json_auto(${l}, union_by_name = true${fn(f)})`;

export const readLines: FormatDef['reader'] = (l, f) =>
  `read_csv(${l}, delim = E'\\x01', quote = '', escape = '', header = false, auto_detect = false, null_padding = true, strict_mode = false, columns = {'line': 'VARCHAR'}${fn(f)})`;
