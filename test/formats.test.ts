import { describe, expect, it } from 'vitest';
import { FORMATS, TEMPLATES, detectFormat, hasOtel, otelSelect, resolveFormat, timeFieldFor } from '../src/formats';
import { viewSelect } from '../src/datasource';

describe('detectFormat', () => {
  it('recognises the AWS delivery layouts by path', () => {
    expect(detectFormat(['s3://b/AWSLogs/1/elasticloadbalancing/r/2026/09/16/1_elasticloadbalancing_r_app.x.y_20260916T0000Z_1.2.3.4_z.log.gz'])).toBe('alb');
    // NLB shares the folder but not the columns: reading it with the ALB layout puts "2.0" in a timestamp
    expect(detectFormat(['s3://b/AWSLogs/1/elasticloadbalancing/r/2026/09/16/1_elasticloadbalancing_r_net.x.y_20260916T0000Z_z.log.gz'])).toBe('csv');
    expect(detectFormat(['s3://b/AWSLogs/1/CloudTrail/r/2026/09/16/1_CloudTrail_r_20260916T0000Z_x.json.gz'])).toBe('cloudtrail');
    expect(detectFormat(['s3://b/AWSLogs/1/vpcflowlogs/r/2026/09/16/1_vpcflowlogs_r_fl-1_20260916T0000Z_h.log.gz'])).toBe('flowlogs');
    expect(detectFormat(['s3://b/cf/E2EXAMPLE12345.2026-09-16-01.abcdef12.gz'])).toBe('cloudfront');
    expect(detectFormat(['s3://b/logs/2026-09-16-01-00-00-0123456789ABCDEF'])).toBe('s3access');
    expect(detectFormat(['s3://b/AWSLogs/1/WAFLogs/r/acl/2026/09/16/01/00/x.log.gz'])).toBe('json');
    expect(detectFormat(['s3://b/x/access.ltsv.gz'])).toBe('ltsv');
  });

  it('goes by extension otherwise and lets Parquet win over path hints', () => {
    expect(detectFormat(['s3://b/x/events.jsonl.zst'])).toBe('json');
    expect(detectFormat(['s3://b/x/events.csv.gz'])).toBe('csv');
    expect(detectFormat(['s3://b/x/app.log'])).toBe('csv');
    expect(detectFormat(['s3://b/AWSLogs/1/elasticloadbalancing/r/dt=2026-09-16/hour=01/data.parquet'])).toBe('parquet');
    expect(detectFormat(['s3://b/x/unknown.bin'])).toBe('parquet');
    expect(detectFormat([])).toBe('parquet');
  });

  it('resolves "auto" through detection and keeps explicit choices', () => {
    expect(resolveFormat('auto', ['s3://b/x.csv']).id).toBe('csv');
    expect(resolveFormat('lines', ['s3://b/x.csv']).id).toBe('lines');
  });
});

describe('readers', () => {
  const list = `['s3://b/a.gz', 's3://b/b.gz']`;

  it('fixed layouts never auto-detect and carry their column lists', () => {
    const alb = FORMATS.alb.reader(list, true);
    expect(alb).toContain('read_csv(');
    expect(alb).toContain('auto_detect = false');
    expect(alb).toContain(`'time': 'TIMESTAMP'`);
    expect(alb).toContain('filename = true');
    expect(alb).toContain("timestampformat = '%Y-%m-%dT%H:%M:%S.%fZ'");
    expect(FORMATS.cloudfront.reader(list, false)).toContain('skip = 2');
    expect(FORMATS.cloudfront.reader(list, false)).not.toContain('filename');
  });

  it('CloudTrail unnests Records and keeps the file name', () => {
    const inner = `SELECT * FROM ${FORMATS.cloudtrail.reader(list, true)}`;
    expect(FORMATS.cloudtrail.wrap!(inner)).toMatch(/unnest\(Records\)/);
    expect(FORMATS.cloudtrail.timeField).toBe('eventTime');
  });

  it('line formats read one VARCHAR column and derive the rest', () => {
    for (const id of ['ltsv', 'cwlexport', 'lines'] as const) expect(FORMATS[id].reader(list, false)).toContain(`columns = {'line': 'VARCHAR'}`);
    expect(FORMATS.ltsv.select).toContain('AS log');
    expect(FORMATS.cwlexport.select).toContain('AS "timestamp"');
  });

  it('every template names a known format and a bucket placeholder', () => {
    for (const tp of TEMPLATES) {
      expect(tp.urls.startsWith('s3://<bucket>/')).toBe(true);
      expect(tp.format === 'auto' || tp.format in FORMATS).toBe(true);
    }
  });
});

describe('OpenTelemetry names', () => {
  const OTEL_FORMATS = ['alb', 'cloudfront', 's3access'] as const;
  /** The columns the reader declares, straight out of its `columns = {...}` list. */
  const declared = (id: (typeof OTEL_FORMATS)[number]) => [...FORMATS[id].reader(`['x']`, false).matchAll(/'([a-z0-9_]+)': '[A-Z]/g)].map((m) => m[1]).sort();
  /** The columns an expression reads (identifiers are always quoted in the projection). */
  const used = (id: (typeof OTEL_FORMATS)[number]) => [...new Set(FORMATS[id].otel!.flatMap(([, e]) => [...e.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1])))].sort();

  it('reads every column of the layout and nothing else', () => {
    // A field AWS appends later is dead until it appears here, and a typo would silently make the
    // view fail to bind; both are caught by comparing the two lists.
    for (const id of OTEL_FORMATS) expect(used(id)).toEqual(declared(id));
  });

  it('gives every column a name of its own', () => {
    for (const id of OTEL_FORMATS) {
      const names = FORMATS[id].otel!.map(([n]) => n);
      expect([...new Set(names)]).toEqual(names);
      expect(names[0]).toBe('timestamp');
    }
  });

  it('moves the time field to "timestamp" and leaves the other naming alone', () => {
    expect(timeFieldFor(FORMATS.alb, 'otel')).toBe('timestamp');
    expect(timeFieldFor(FORMATS.alb, 'native')).toBe('time');
    expect(hasOtel(FORMATS.json)).toBe(false);
    expect(otelSelect(FORMATS.json)).toBeNull();
  });

  it('replaces the star and the derived columns of the layout, and keeps _file', () => {
    const sql = viewSelect(FORMATS.alb, ['s3://b/a.log.gz'], null, true, 'otel');
    expect(sql).not.toContain('SELECT * EXCLUDE');
    expect(sql).toContain('"time" AS "timestamp"');
    expect(sql).toContain('filename AS _file');
    // a format without a projection is read under its own names whatever the naming says
    expect(viewSelect(FORMATS.parquet, ['s3://b/a.parquet'], null, true, 'otel')).toBe(viewSelect(FORMATS.parquet, ['s3://b/a.parquet'], null, true, 'native'));
  });
});
