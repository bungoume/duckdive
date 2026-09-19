import { describe, expect, it } from 'vitest';
import { FORMATS, FORMAT_IDS, TEMPLATES, detectFormat, hasOtel, otelRename, otelSelect, resolveFormat, timeFieldFor } from '../src/formats';
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
    expect(detectFormat(['s3://b/AWSLogs/1/WAFLogs/r/acl/2026/09/16/01/00/x.log.gz'])).toBe('waf');
    expect(detectFormat(['s3://b/AWSLogs/1/vpcdnsquerylogs/vpc-1/2026/09/16/vpc-1_vpcdnsquerylogs_1_x.log.gz'])).toBe('r53resolver');
    // Network Firewall has no layout of its own yet, so it stays plain JSON lines
    expect(detectFormat(['s3://b/AWSLogs/1/network-firewall/alert/r/fw/2026/09/16/01/x.log.gz'])).toBe('json');
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

  it('reads numbers as text and casts them in the view, so a "-" cannot fail the query', () => {
    // AWS writes "-" where a number is absent (CloudFront's sc_content_len for a response without
    // a Content-Length); a column declared as a number made DuckDB fail every query that read it.
    expect(FORMATS.alb.reader(list, true)).toContain(`'elb_status_code': 'VARCHAR'`);
    expect(FORMATS.cloudfront.reader(list, true)).toContain(`'sc_content_len': 'VARCHAR'`);
    // every numeric column of the layout, not only the one that was found to break
    expect(FORMATS.alb.replace).toBe(
      ` REPLACE (TRY_CAST("request_processing_time" AS DOUBLE) AS "request_processing_time", TRY_CAST("target_processing_time" AS DOUBLE) AS "target_processing_time", TRY_CAST("response_processing_time" AS DOUBLE) AS "response_processing_time", TRY_CAST("elb_status_code" AS INTEGER) AS "elb_status_code", TRY_CAST("received_bytes" AS BIGINT) AS "received_bytes", TRY_CAST("sent_bytes" AS BIGINT) AS "sent_bytes")`,
    );
    expect(FORMATS.cloudfront.replace).toContain(`TRY_CAST("sc_content_len" AS BIGINT) AS "sc_content_len"`);
    expect(FORMATS.s3access.replace).toContain(`TRY_CAST("http_status" AS INTEGER) AS "http_status"`);
    // the time fields are not numeric: they keep their declared type and the reader's timestampformat
    expect(FORMATS.alb.reader(list, true)).toContain(`'time': 'TIMESTAMP'`);
    expect(FORMATS.alb.replace).not.toContain('"time"');
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
  const used = (id: (typeof OTEL_FORMATS)[number]) => [...new Set(FORMATS[id].otel!.columns.flatMap(([, e]) => [...e.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1])))].sort();

  it('reads every column of the layout and nothing else', () => {
    // A field AWS appends later is dead until it appears here, and a typo would silently make the
    // view fail to bind; both are caught by comparing the two lists.
    for (const id of OTEL_FORMATS) expect(used(id)).toEqual(declared(id));
  });

  it('gives every column a name of its own, in every layout that has a projection', () => {
    for (const id of FORMAT_IDS) {
      const otel = id === 'auto' ? undefined : FORMATS[id].otel;
      if (!otel) continue;
      const names = otel.columns.map(([n]) => n);
      expect([...new Set(names)]).toEqual(names);
      expect(names[0]).toBe('timestamp');
    }
  });

  it('reads a JSON family record by record, so a key a file lacks is NULL and not a bind error', () => {
    // the families span three providers; all of them are read the same way
    for (const id of ['cloudtrail', 'waf', 'r53resolver', 'gcplog', 'cflogpush'] as const) {
      const sql = viewSelect(FORMATS[id], ['s3://b/a.log.gz'], null, true, 'otel');
      expect(sql).toContain('read_json_objects(');
      // no schema is inferred, so binding the view reads nothing and opens no other file
      expect(sql).not.toContain('union_by_name');
      // and nothing is lost: the whole record stays reachable through body.<key>
      expect(sql).toContain('AS "body"');
      // the native naming still reads them through the inferred schema
      expect(viewSelect(FORMATS[id], ['s3://b/a.log.gz'], null, true, 'native')).toContain('read_json_auto(');
    }
    // CloudTrail keeps one row per Record without the wrap the native reader needs
    expect(viewSelect(FORMATS.cloudtrail, ['s3://b/a.json.gz'], null, true, 'otel')).toContain(`unnest(json_extract("json", '$.Records')::JSON[])`);
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
    expect(sql).toContain('TRY_CAST("received_bytes" AS BIGINT) AS "http.request.size"');
    expect(sql).toContain('filename AS _file');
    expect(viewSelect(FORMATS.alb, ['s3://b/a.log.gz'], null, true, 'native')).toContain('* EXCLUDE (filename) REPLACE (TRY_CAST(');
    // a format without a projection is read under its own names whatever the naming says
    expect(viewSelect(FORMATS.parquet, ['s3://b/a.parquet'], null, true, 'otel')).toBe(viewSelect(FORMATS.parquet, ['s3://b/a.parquet'], null, true, 'native'));
  });
});

describe('OpenTelemetry names for a layout whose columns come from the file', () => {
  const flow = (cols: string[], keep: string[] = []) => otelRename(FORMATS.flowlogs.otelByName!, cols, new Set(keep));

  it('reads the two spellings of a flow log field as one field', () => {
    // text delivery writes the header with hyphens, Parquet delivery with underscores
    expect(flow(['account-id'])).toBe(flow(['account_id']).replace('account_id', 'account-id'));
    expect(flow(['flow-direction'])).toContain('AS "network.io.direction"');
    expect(flow(['flow_direction'])).toContain('AS "network.io.direction"');
  });

  it('keeps the value the conventions have no room for beside the one they name', () => {
    const sql = flow(['protocol', 'type']);
    expect(sql).toContain('AS "network.transport"');
    expect(sql).toContain('AS "aws.vpc.flow.protocol"');
    expect(sql).toContain('AS "network.type"');
    expect(sql).toContain('AS "aws.vpc.flow.type"');
  });

  it('gives a field it does not name its own namespace, so a custom format still reads', () => {
    expect(flow(['pkt-src-aws-service'])).toBe('"pkt-src-aws-service" AS "aws.vpc.flow.pkt_src_aws_service"');
    expect(flow(['some-field-aws-adds-later'])).toContain('AS "aws.vpc.flow.some_field_aws_adds_later"');
  });

  it("leaves the columns that are duckdive's own alone", () => {
    expect(flow(['_file', 'account', 'srcaddr'], ['_file', 'account'])).toBe('"_file", "account", "srcaddr" AS "source.address"');
  });

  it('reads "-" as no value, which is what a flow log means by it', () => {
    expect(FORMATS.flowlogs.reader(`['x']`, false)).toContain("nullstr = '-'");
  });
});
