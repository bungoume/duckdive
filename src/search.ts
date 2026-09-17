// Lucene query syntax → DuckDB SQL WHERE clause.
//
// Supported syntax (Lucene classic query parser, as used by the "query string" search of many log tools):
//   free text            error timeout          (each word matches any searchable field; words are OR-ed)
//   phrase               "connection reset"     "read timeout"~3 (proximity: all words in the same field)
//   field value          status:500   method:GET   message:"read timeout"
//   wildcard             host:web-*   user.name:w?b   (? = one character, * = any characters)
//   regex                path:/api\/v[12]\/.*/   (unanchored, case-sensitive)
//   exists               user.name:*   _exists_:user.name
//   grouping             status:(500 OR 503)   (a OR b) AND c
//   ranges               bytes:[100 TO 200]   bytes:{100 TO 200]   ts:[2024-01-01 TO *]
//                        bytes:>1000   bytes:>=10   ts:<"2024-01-01"
//   boolean operators    AND, OR, NOT (upper case), &&, ||, !
//   required/prohibited  +status:500 -method:GET
//   implicit operator    status:500 method:POST → OR (as in Lucene; use AND or + to require both)
//   escaping             \ before any special character:  path:\/api\/v1
//   fuzzy / boost        term~ term~2 term^3 are accepted; the fuzziness and boost are ignored
//   nested fields        geo.country:JP   extra.user_id:42

import { parseDateMath } from './datemath';
import type { Field } from './fields';
import { findField } from './fields';
import { lit, notSql, tsLit } from './sql';

export type Node =
  | { t: 'and'; a: Node[] }
  | { t: 'or'; a: Node[] }
  | { t: 'not'; a: Node }
  | { t: 'text'; value: string; phrase: boolean; prox: boolean }
  | { t: 'term'; field: string; value: string; phrase: boolean; prox: boolean }
  | { t: 'regex'; field: string | null; value: string }
  | { t: 'exists'; field: string }
  | { t: 'range'; field: string; op: '<' | '<=' | '>' | '>='; value: string }
  | { t: 'between'; field: string; lo: string | null; hi: string | null; incLo: boolean; incHi: boolean };

type Tok =
  | { k: 'lp' | 'rp' | 'colon' | 'lb' | 'rb' | 'lc' | 'rc' }
  | { k: 'and' | 'or' | 'not' }
  | { k: 'plus' | 'minus' }
  | { k: 'word'; v: string }
  | { k: 'str'; v: string; prox: boolean }
  | { k: 're'; v: string };

export class SearchQueryError extends Error {}

type Occur = 'must' | 'mustNot' | 'should';

const SPECIAL = new Set(['(', ')', ':', '"', '[', ']', '{', '}', '^', '~']);

/** Read a trailing ~[n] (fuzzy / proximity) or ^n (boost) suffix. Returns [next index, had ~]. */
function readSuffix(s: string, i: number): [number, boolean] {
  let prox = false;
  for (;;) {
    if (s[i] === '~') {
      prox = true;
      i++;
      while (i < s.length && /[0-9.]/.test(s[i])) i++;
    } else if (s[i] === '^') {
      i++;
      while (i < s.length && /[0-9.]/.test(s[i])) i++;
    } else return [i, prox];
  }
}

/** Lucene treats /.../ as a regex. Only take it when the closing slash ends the token, so path:/api/* stays a plain value. */
function readRegex(s: string, i: number): [string, number] | null {
  let j = i + 1;
  let v = '';
  while (j < s.length) {
    if (s[j] === '\\' && j + 1 < s.length) {
      v += s[j] + s[j + 1];
      j += 2;
      continue;
    }
    if (s[j] === '/') {
      const [k] = readSuffix(s, j + 1);
      const nx = s[k];
      if (nx === undefined || /\s/.test(nx) || nx === ')') return [v.replace(/\\\//g, '/'), k];
      return null;
    }
    v += s[j++];
  }
  return null;
}

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  const last = () => toks[toks.length - 1];
  const afterColon = () => last()?.k === 'colon';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') toks.push({ k: 'lp' });
    else if (c === ')') toks.push({ k: 'rp' });
    else if (c === '[') toks.push({ k: 'lb' });
    else if (c === ']') toks.push({ k: 'rb' });
    else if (c === '{') toks.push({ k: 'lc' });
    else if (c === '}') toks.push({ k: 'rc' });
    else if (c === ':') toks.push({ k: 'colon' });
    else if (c === '^' || c === '~') throw new SearchQueryError(`Unexpected "${c}"`);
    else if (s.startsWith('&&', i)) {
      toks.push({ k: 'and' });
      i++;
    } else if (s.startsWith('||', i)) {
      toks.push({ k: 'or' });
      i++;
    } else if (c === '!' && !afterColon()) toks.push({ k: 'not' });
    else if ((c === '+' || c === '-') && !afterColon() && i + 1 < s.length && !/\s/.test(s[i + 1])) toks.push({ k: c === '+' ? 'plus' : 'minus' });
    else if (c === '"') {
      let j = i + 1;
      let v = '';
      let closed = false;
      while (j < s.length) {
        if (s[j] === '\\' && j + 1 < s.length) {
          v += s[j + 1];
          j += 2;
          continue;
        }
        if (s[j] === '"') {
          closed = true;
          break;
        }
        v += s[j++];
      }
      if (!closed) throw new SearchQueryError('Unterminated quoted string');
      const [k, prox] = readSuffix(s, j + 1);
      toks.push({ k: 'str', v, prox });
      i = k;
      continue;
    } else {
      if (c === '/') {
        const re = readRegex(s, i);
        if (re) {
          toks.push({ k: 're', v: re[0] });
          i = re[1];
          continue;
        }
      }
      let j = i;
      let v = '';
      while (j < s.length && !/\s/.test(s[j]) && !SPECIAL.has(s[j]) && !s.startsWith('&&', j) && !s.startsWith('||', j)) {
        if (s[j] === '\\' && j + 1 < s.length) {
          v += s[j + 1];
          j += 2;
          continue;
        }
        v += s[j++];
      }
      if (v === 'AND') toks.push({ k: 'and' });
      else if (v === 'OR') toks.push({ k: 'or' });
      else if (v === 'NOT') toks.push({ k: 'not' });
      else toks.push({ k: 'word', v });
      [i] = readSuffix(s, j);
      continue;
    }
    i++;
  }
  return toks;
}

/** Combine the clauses of one group the way a Lucene BooleanQuery does (minus scoring). */
function combine(clauses: { occur: Occur; node: Node }[]): Node {
  const must = clauses.filter((c) => c.occur === 'must').map((c) => c.node);
  const mustNot = clauses.filter((c) => c.occur === 'mustNot').map((c) => c.node);
  const should = clauses.filter((c) => c.occur === 'should').map((c) => c.node);
  const parts: Node[] = [];
  if (must.length) parts.push(...must);
  else if (should.length) parts.push(should.length === 1 ? should[0] : { t: 'or', a: should });
  for (const n of mustNot) parts.push({ t: 'not', a: n });
  return parts.length === 1 ? parts[0] : { t: 'and', a: parts };
}

class Parser {
  private pos = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private next(): Tok {
    const t = this.toks[this.pos++];
    if (!t) throw new SearchQueryError('Unexpected end of query');
    return t;
  }

  parse(): Node | null {
    if (!this.toks.length) return null;
    const n = this.parseGroup(null);
    if (this.pos < this.toks.length) throw new SearchQueryError(`Unexpected "${describe(this.peek()!)}"`);
    return n;
  }

  private startsClause(t: Tok | undefined): boolean {
    return !!t && (t.k === 'lp' || t.k === 'str' || t.k === 'word' || t.k === 're' || t.k === 'not' || t.k === 'plus' || t.k === 'minus');
  }

  /** clause clause ... (no operator between them: Lucene's default OR, with +/- handled per clause). */
  private parseGroup(field: string | null): Node {
    const clauses = [this.parseOr(field)];
    while (this.startsClause(this.peek())) clauses.push(this.parseOr(field));
    return combine(clauses);
  }

  private parseOr(field: string | null): { occur: Occur; node: Node } {
    const items = [this.parseAnd(field)];
    while (this.peek()?.k === 'or') {
      this.next();
      items.push(this.parseAnd(field));
    }
    if (items.length === 1) return items[0];
    return { occur: 'should', node: { t: 'or', a: items.map((c) => (c.occur === 'mustNot' ? { t: 'not', a: c.node } : c.node)) } };
  }

  private parseAnd(field: string | null): { occur: Occur; node: Node } {
    const items = [this.parseUnary(field)];
    while (this.peek()?.k === 'and') {
      this.next();
      items.push(this.parseUnary(field));
    }
    if (items.length === 1) return items[0];
    return { occur: 'should', node: { t: 'and', a: items.map((c) => (c.occur === 'mustNot' ? { t: 'not', a: c.node } : c.node)) } };
  }

  private parseUnary(field: string | null): { occur: Occur; node: Node } {
    const t = this.peek();
    if (t?.k === 'not' || t?.k === 'minus') {
      this.next();
      const inner = this.parseUnary(field);
      return { occur: inner.occur === 'mustNot' ? 'must' : 'mustNot', node: inner.node };
    }
    if (t?.k === 'plus') {
      this.next();
      const inner = this.parseUnary(field);
      return { occur: inner.occur === 'mustNot' ? 'mustNot' : 'must', node: inner.node };
    }
    return { occur: 'should', node: this.parsePrimary(field) };
  }

  private parsePrimary(field: string | null): Node {
    const t = this.next();
    if (t.k === 'lp') {
      if (this.peek()?.k === 'rp') throw new SearchQueryError('Empty parentheses');
      const n = this.parseGroup(field);
      const r = this.next();
      if (r.k !== 'rp') throw new SearchQueryError('Expected ")"');
      return n;
    }
    if (t.k === 'str') {
      return field ? { t: 'term', field, value: t.v, phrase: true, prox: t.prox } : { t: 'text', value: t.v, phrase: true, prox: t.prox };
    }
    if (t.k === 're') return { t: 'regex', field, value: t.v };
    if (t.k === 'word') {
      if (!field && this.peek()?.k === 'colon') {
        this.next();
        if (t.v === '_exists_') {
          const f = this.next();
          if (f.k !== 'word') throw new SearchQueryError('Expected a field name after "_exists_:"');
          return { t: 'exists', field: f.v };
        }
        return this.parseFieldValue(t.v);
      }
      if (field) return { t: 'term', field, value: t.v, phrase: false, prox: false };
      return { t: 'text', value: t.v, phrase: false, prox: false };
    }
    throw new SearchQueryError(`Unexpected "${describe(t)}"`);
  }

  private parseFieldValue(field: string): Node {
    const t = this.peek();
    if (!t) throw new SearchQueryError(`Expected a value after "${field}:"`);
    if (t.k === 'lp') {
      this.next();
      if (this.peek()?.k === 'rp') throw new SearchQueryError('Empty parentheses');
      const n = this.parseGroup(field);
      const r = this.next();
      if (r.k !== 'rp') throw new SearchQueryError('Expected ")"');
      return n;
    }
    if (t.k === 'lb' || t.k === 'lc') {
      this.next();
      const incLo = t.k === 'lb';
      const lo = this.next();
      const to = this.next();
      const hi = this.next();
      const close = this.next();
      if ((lo.k !== 'word' && lo.k !== 'str') || to.k !== 'word' || to.v !== 'TO' || (hi.k !== 'word' && hi.k !== 'str')) throw new SearchQueryError('Expected [lower TO upper]');
      if (close.k !== 'rb' && close.k !== 'rc') throw new SearchQueryError('Expected "]" or "}"');
      return {
        t: 'between',
        field,
        lo: lo.v === '*' ? null : lo.v,
        hi: hi.v === '*' ? null : hi.v,
        incLo,
        incHi: close.k === 'rb',
      };
    }
    if (t.k === 're') {
      this.next();
      return { t: 'regex', field, value: t.v };
    }
    if (t.k === 'str') {
      this.next();
      return { t: 'term', field, value: t.v, phrase: true, prox: t.prox };
    }
    if (t.k === 'word') {
      this.next();
      const m = /^(>=|<=|>|<)(.*)$/.exec(t.v);
      if (m) {
        let v = m[2];
        if (!v) {
          const nx = this.next();
          if (nx.k !== 'str') throw new SearchQueryError(`Expected a value after "${field}:${m[1]}"`);
          v = nx.v;
        }
        return { t: 'range', field, op: m[1] as '<' | '<=' | '>' | '>=', value: v };
      }
      if (t.v === '*') return { t: 'exists', field };
      return { t: 'term', field, value: t.v, phrase: false, prox: false };
    }
    throw new SearchQueryError(`Expected a value after "${field}:"`);
  }
}

function describe(t: Tok): string {
  switch (t.k) {
    case 'word':
      return t.v;
    case 'str':
      return `"${t.v}"`;
    case 're':
      return `/${t.v}/`;
    case 'and':
      return 'AND';
    case 'or':
      return 'OR';
    case 'not':
      return 'NOT';
    case 'plus':
      return '+';
    case 'minus':
      return '-';
    case 'lp':
      return '(';
    case 'rp':
      return ')';
    case 'lb':
      return '[';
    case 'rb':
      return ']';
    case 'lc':
      return '{';
    case 'rc':
      return '}';
    case 'colon':
      return ':';
  }
}

export function parseQuery(q: string): Node | null {
  return new Parser(tokenize(q)).parse();
}

// ---------- SQL generation ----------

function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lucene wildcard (* and ?) → regex body. `within` is the class a wildcard may expand to. */
function wildcardRe(value: string, within: string): string {
  let out = '';
  for (const c of value) {
    if (c === '*') out += `${within}*`;
    else if (c === '?') out += within;
    else out += reEscape(c);
  }
  return out;
}

function hasWildcard(v: string): boolean {
  return v.includes('*') || v.includes('?');
}

/** Token-bounded, case-insensitive match; * and ? are wildcards within a token. */
function tokenMatch(expr: string, value: string): string {
  const body = wildcardRe(value, '[^\\s]');
  if (!body) return `${expr} IS NOT NULL`;
  const re = `(^|[^A-Za-z0-9_])${body}([^A-Za-z0-9_]|$)`;
  return `regexp_matches(${expr}, ${lit(re)}, 'i')`;
}

function phraseMatch(expr: string, value: string): string {
  if (hasWildcard(value)) return `regexp_matches(${expr}, ${lit(wildcardRe(value, '.'))}, 'i')`;
  const esc = value.replace(/[\\%_]/g, '\\$&');
  return `${expr} ILIKE ${lit('%' + esc + '%')} ESCAPE '\\'`;
}

/** "a b"~n: every word of the phrase appears in the field (order and distance are not enforced). */
function proximityMatch(expr: string, value: string): string {
  const words = value.split(/\s+/).filter(Boolean);
  if (!words.length) return 'FALSE';
  if (words.length === 1) return tokenMatch(expr, words[0]);
  return '(' + words.map((w) => tokenMatch(expr, w)).join(' AND ') + ')';
}

function textMatch(expr: string, value: string, phrase: boolean, prox: boolean): string {
  if (phrase && prox) return proximityMatch(expr, value);
  return phrase || value.includes(' ') ? phraseMatch(expr, value) : tokenMatch(expr, value);
}

function stringExpr(f: Field): string {
  return f.kind === 'string' ? f.expr : `(${f.expr})::VARCHAR`;
}

/** A bound of a range. Dates accept date math (now-1h, now/d: `roundUp` picks the end of a rounded unit for an upper bound). */
function scalarLiteral(f: Field, v: string, roundUp = false): string {
  if (f.kind === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new SearchQueryError(`"${v}" is not a number (field ${f.name})`);
    return String(n);
  }
  if (f.kind === 'date') {
    if (v.startsWith('now')) {
      const d = parseDateMath(v, roundUp);
      if (!d) throw new SearchQueryError(`"${v}" is not a date expression (field ${f.name})`);
      return tsLit(d);
    }
    return `TRY_CAST(${lit(v)} AS TIMESTAMP)`;
  }
  if (f.kind === 'boolean') return v.toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
  return lit(v);
}

function termSql(f: Field, value: string, phrase: boolean, prox: boolean): string {
  switch (f.kind) {
    case 'number': {
      const n = Number(value);
      if (Number.isFinite(n)) return `${f.expr} = ${n}`;
      return phraseMatch(`(${f.expr})::VARCHAR`, value);
    }
    case 'boolean': {
      const v = value.toLowerCase();
      if (v === 'true' || v === 'false') return `${f.expr} = ${v.toUpperCase()}`;
      return 'FALSE';
    }
    case 'date':
      return phraseMatch(`(${f.expr})::VARCHAR`, value);
    default:
      return textMatch(stringExpr(f), value, phrase, prox);
  }
}

function resolve(fields: Field[], name: string): Field {
  const f = findField(fields, name);
  if (!f) throw new SearchQueryError(`Unknown field "${name}"`);
  return f;
}

function searchTargets(fields: Field[]): Field[] {
  return fields.filter((f) => f.searchable && f.kind !== 'object');
}

export function nodeToSql(n: Node, fields: Field[]): string {
  switch (n.t) {
    case 'and':
      return '(' + n.a.map((x) => nodeToSql(x, fields)).join(' AND ') + ')';
    case 'or':
      return '(' + n.a.map((x) => nodeToSql(x, fields)).join(' OR ') + ')';
    case 'not':
      return notSql(nodeToSql(n.a, fields));
    case 'text': {
      const targets = searchTargets(fields);
      if (!targets.length) return 'FALSE';
      return '(' + targets.map((f) => textMatch(stringExpr(f), n.value, n.phrase, n.prox)).join(' OR ') + ')';
    }
    case 'term': {
      const f = resolve(fields, n.field);
      if (n.value === '*') return `${f.expr} IS NOT NULL`;
      return `(${termSql(f, n.value, n.phrase, n.prox)})`;
    }
    case 'regex': {
      const targets = n.field === null ? searchTargets(fields) : [resolve(fields, n.field)];
      if (!targets.length) return 'FALSE';
      const alts = targets.map((f) => `regexp_matches(${stringExpr(f)}, ${lit(n.value)})`);
      return alts.length === 1 ? alts[0] : '(' + alts.join(' OR ') + ')';
    }
    case 'exists':
      return `${resolve(fields, n.field).expr} IS NOT NULL`;
    case 'range': {
      const f = resolve(fields, n.field);
      return `(${f.expr} ${n.op} ${scalarLiteral(f, n.value, n.op === '<=')})`;
    }
    case 'between': {
      const f = resolve(fields, n.field);
      const c: string[] = [];
      if (n.lo !== null) c.push(`${f.expr} ${n.incLo ? '>=' : '>'} ${scalarLiteral(f, n.lo)}`);
      if (n.hi !== null) c.push(`${f.expr} ${n.incHi ? '<=' : '<'} ${scalarLiteral(f, n.hi, n.incHi)}`);
      return c.length ? '(' + c.join(' AND ') + ')' : 'TRUE';
    }
  }
}

/** Compile a query string to SQL. Empty query → 'TRUE'. Throws SearchQueryError. */
export function searchToSql(q: string, fields: Field[]): string {
  const n = parseQuery(q);
  if (!n) return 'TRUE';
  return nodeToSql(n, fields);
}
