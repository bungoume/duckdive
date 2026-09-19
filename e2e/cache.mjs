// End-to-end test of the extension against an S3 stand-in WITHOUT any CORS headers:
// host permissions, OPFS range cache (persistence across reload), SigV4 signing and STS credentials.
// Prereqs: `DDV_EXTRA_HOSTS="http://localhost/*" pnpm run build`, `duckdb` CLI on PATH.
//   node e2e/cache.mjs                        screenshots → release/e2e/*.png
import { spawn, execSync } from 'node:child_process';
import { launchExtension, settled, waitReady } from './ext-context.mjs';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dataPort = Number(process.env.DATA_PORT ?? 5299);
const dataDir = process.env.DATA_DIR ?? join(tmpdir(), 'ddv-fixtures');
const out = process.env.OUT ?? new URL('../release/e2e', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
mkdirSync(dataDir, { recursive: true });
const parquet = join(dataDir, 'logs.parquet');
import { rmSync } from 'node:fs';
rmSync(join(dataDir, 'bucket'), { recursive: true, force: true }); // fixtures are regenerated every run
mkdirSync(join(dataDir, 'bucket'), { recursive: true });
// The fixture spans the last 7 days relative to its creation: regenerate it once it is a day old,
// otherwise "Last 6 hours" (the default range) finds nothing.
if (!existsSync(parquet) || Date.now() - statSync(parquet).mtimeMs > 24 * 3600_000) {
  console.log('generating fixture parquet with duckdb CLI…');
  execSync(
    `duckdb -c "COPY (SELECT now()::TIMESTAMP - to_seconds(floor(random()*604800)::BIGINT) AS ts, ['GET','POST','PUT'][1+floor(random()*3)::INT] AS method, (200 + floor(random()*400))::INT AS status, md5(i::VARCHAR) AS session, random()*1000 AS latency_ms, repeat('x', 200) AS payload FROM range(600000) t(i)) TO '${parquet}' (FORMAT PARQUET, ROW_GROUP_SIZE 50000)"`,
    { stdio: 'inherit' },
  );
}

import { copyFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
copyFileSync(parquet, join(dataDir, 'bucket', 'logs.parquet'));
// Date-partitioned layout (UTC), like AWS log delivery: today and yesterday.
const pad = (n) => String(n).padStart(2, '0');
const dayPath = (d) => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
const today = new Date();
const yesterday = new Date(Date.now() - 86400_000);
const old = new Date(Date.now() - 40 * 86400_000);
for (const d of [today, yesterday, old]) {
  const dir = join(dataDir, 'bucket', 'AWSLogs', '123456789012', 'parquet', 'ap-northeast-1', dayPath(d));
  mkdirSync(dir, { recursive: true });
  copyFileSync(parquet, join(dir, `part-${dayPath(d).replace(/\//g, '')}.parquet`));
  // ALB access log lines (space separated, quoted request / user agent), gzipped
  const albDir = join(dataDir, 'bucket', 'AWSLogs', '123456789012', 'elasticloadbalancing', 'ap-northeast-1', dayPath(d));
  mkdirSync(albDir, { recursive: true });
  const lines = [];
  for (let i = 0; i < 500; i++) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), i % 24, (i * 7) % 60, i % 60, i % 1000)).toISOString().replace('Z', String(i % 1000).padStart(3, '0') + 'Z');
    const status = i % 17 === 0 ? 503 : i % 5 === 0 ? 404 : 200;
    const base = `http ${t} app/alb-app-dev/1a2b3c4d5e6f7a8b 203.0.113.${i % 255}:${40000 + i} 10.0.1.${i % 200}:8080 0.001 0.0${i % 9} 0.000 ${status} ${status} 512 ${1000 + i} "GET https://www.example.com:443/api/articles/${i} HTTP/1.1" "Mozilla/5.0 (Macintosh) Chrome/126" ECDHE-RSA-AES128-GCM-SHA256 TLSv1.2 arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:targetgroup/tg/abc "Root=1-${i}" "www.example.com" "arn:aws:acm:ap-northeast-1:123456789012:certificate/xyz" 1 ${t} "forward" "-" "-" "10.0.1.${i % 200}:8080" "${status}" "-" "-" TID_${i}`;
    // today's files use the current 34-field layout, older ones the 30-field layout
    lines.push(d === today ? `${base} "-" "-" "-" 10.0.0.${i % 9}` : base);
  }
  const gz = gzipSync(lines.join('\n') + '\n');
  const day = dayPath(d).replace(/\//g, '');
  // a fixed stamp at 00:00 UTC of the day: in the past, and outside a Last-1-hour window
  // unless the test runs before 02:05 UTC (accounted for in the prune check)
  const farHour = '00';
  writeFileSync(join(albDir, `123456789012_elasticloadbalancing_ap-northeast-1_app.alb-app-dev.1a2b3c4d5e6f7a8b_${day}T${farHour}00Z_198.51.100.23_36sx4l7r.log.gz`), gz);
  // a second load balancer sharing the day folder (must be excluded by a name prefix)
  writeFileSync(join(albDir, `123456789012_elasticloadbalancing_ap-northeast-1_app.alb-other.0123456789abcdef_${day}T${farHour}00Z_198.51.100.24_zzzzzzzz.log.gz`), gz);
  if (d === today) {
    // a file whose name timestamp is "now" (rounded to 5 minutes): the only one inside "Last 1 hour"
    const now = new Date(Math.floor(Date.now() / 300000) * 300000);
    const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 13) + 'Z';
    writeFileSync(join(albDir, `123456789012_elasticloadbalancing_ap-northeast-1_app.alb-app-dev.1a2b3c4d5e6f7a8b_${stamp}_198.51.100.23_nownownow.log.gz`), gz);
  }
}

// Fixtures for the other AWS log families (today's UTC partition, file stamped "now")
{
  const stamp = today.toISOString().replace(/[-:]/g, '').slice(0, 13) + 'Z';
  const dp = dayPath(today);
  const hh = pad(today.getUTCHours());
  const dash = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}`;
  const w = (rel, content) => {
    const f = join(dataDir, 'bucket', rel);
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, content);
  };
  // CloudTrail
  w(
    `AWSLogs/123456789012/CloudTrail/ap-northeast-1/${dp}/123456789012_CloudTrail_ap-northeast-1_${stamp}_abc.json.gz`,
    gzipSync(
      JSON.stringify({
        Records: [
          {
            eventVersion: '1.08',
            eventTime: today.toISOString(),
            eventSource: 's3.amazonaws.com',
            eventName: 'GetObject',
            awsRegion: 'ap-northeast-1',
            sourceIPAddress: '203.0.113.9',
            userIdentity: { type: 'IAMUser', userName: 'alice' },
          },
          { eventVersion: '1.08', eventTime: today.toISOString(), eventSource: 'sts.amazonaws.com', eventName: 'AssumeRole', awsRegion: 'ap-northeast-1', userIdentity: { type: 'AssumedRole' } },
        ],
      }),
    ),
  );
  // VPC flow logs (with header)
  w(
    `AWSLogs/123456789012/vpcflowlogs/ap-northeast-1/${dp}/123456789012_vpcflowlogs_ap-northeast-1_fl-0123456789abcdef0_${stamp}_hash.log.gz`,
    gzipSync(
      'version account-id interface-id srcaddr dstaddr srcport dstport protocol packets bytes start end action log-status\n' +
        Array.from(
          { length: 50 },
          (_, i) =>
            `2 123456789012 eni-1 10.0.0.${i} 10.0.1.1 ${40000 + i} 443 6 10 ${1000 + i} ${Math.floor(today.getTime() / 1000) - 60} ${Math.floor(today.getTime() / 1000)} ${i % 5 ? 'ACCEPT' : 'REJECT'} OK`,
        ).join('\n') +
        '\n',
    ),
  );
  // CloudFront legacy logs
  w(
    `cf-logs/E2EXAMPLE12345.${dash}-${hh}.abcdef12.gz`,
    gzipSync(
      '#Version: 1.0\n#Fields: date time x-edge-location sc-bytes c-ip cs-method cs(Host) cs-uri-stem sc-status cs(Referer) cs(User-Agent) cs-uri-query cs(Cookie) x-edge-result-type x-edge-request-id x-host-header cs-protocol cs-bytes time-taken x-forwarded-for ssl-protocol ssl-cipher x-edge-response-result-type cs-protocol-version fle-status fle-encrypted-fields c-port time-to-first-byte x-edge-detailed-result-type sc-content-type sc-content-len sc-range-start sc-range-end\n' +
        Array.from({ length: 40 }, (_, i) =>
          [
            dash,
            `${hh}:00:${pad(i)}`,
            'NRT57-P2',
            392,
            '203.0.113.5',
            'GET',
            'd111.cloudfront.net',
            `/p/${i}`,
            i % 7 ? 200 : 503,
            '-',
            'Mozilla/5.0%20(Macintosh)',
            '-',
            '-',
            'Hit',
            'rid' + i,
            'd111.cloudfront.net',
            'https',
            23,
            0.001,
            '-',
            'TLSv1.3',
            'TLS_AES_128_GCM_SHA256',
            'Hit',
            'HTTP/2.0',
            '-',
            '-',
            54321,
            0.001,
            'Hit',
            'text/html',
            78,
            '-',
            '-',
          ].join('\t'),
        ).join('\n') +
        '\n',
    ),
  );
  // S3 server access logs (non-partitioned layout)
  const t = today;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getUTCMonth()];
  const apache = `[${pad(t.getUTCDate())}/${mon}/${t.getUTCFullYear()}:${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00 +0000]`;
  w(
    `s3-logs/${dash}-${hh}-00-00-0123456789ABCDEF`,
    Array.from(
      { length: 30 },
      (_, i) =>
        `79a59df900b949e5 awsexamplebucket1 ${apache} 192.0.2.${i} 79a59df900b949e5 3E57427F3EXAMPLE REST.GET.OBJECT key${i} "GET /awsexamplebucket1/key${i} HTTP/1.1" ${i % 6 ? 200 : 404} - 113 - 7 - "-" "S3Console/0.4" - hostid SigV4 ECDHE-RSA-AES128-GCM-SHA256 AuthHeader awsexamplebucket1.s3.us-west-1.amazonaws.com TLSV1.2 - -`,
    ).join('\n') + '\n',
  );
  // LTSV (nginx style)
  w(
    `ltsv/${dp}/access.ltsv.gz`,
    gzipSync(
      Array.from(
        { length: 25 },
        (_, i) =>
          `time:[${pad(t.getUTCDate())}/${mon}/${t.getUTCFullYear()}:${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(i % 60)} +0000]\thost:10.0.0.${i}\tstatus:${i % 5 ? 200 : 502}\treq:GET /x/${i} HTTP/1.1\treqtime:0.0${i}`,
      ).join('\n') + '\n',
    ),
  );
  // Concatenated (multi-member) gzip, as AWS log delivery writes it. DuckDB loses rows on these
  // (see the concatenated-gzip section): the fixture measures how much.
  {
    const line = (i) => `${t.toISOString()} member ${i} 203.0.113.${i % 255} GET /p/${i} 200\n`;
    const members = [];
    for (let m = 0; m < 3000; m++) members.push(gzipSync(line(m)));
    w(`multigz/${dp}/tiny-members.log.gz`, Buffer.concat(members));
    const big = [];
    for (let m = 0; m < 40; m++) {
      let s = '';
      for (let i = 0; i < 500; i++) s += line(m * 500 + i);
      big.push(gzipSync(s));
    }
    w(`multigz/${dp}/big-members.log.gz`, Buffer.concat(big));
    w(`multigz/${dp}/single.log.gz`, gzipSync(Array.from({ length: 100 }, (_, i) => line(i)).join('')));
  }
  // Plain-line gz files, one of them with a damaged gzip header (compression method 9 instead of 8):
  // DuckDB fails with "Unsupported GZIP compression method" and the diagnosis must name the file.
  w(`badgz/${dp}/aa-good.log.gz`, gzipSync(Array.from({ length: 10 }, (_, i) => `${t.toISOString()} good ${i}`).join('\n') + '\n'));
  w(`badgz/${dp}/mm-good.log.gz`, gzipSync(Array.from({ length: 10 }, (_, i) => `${t.toISOString()} fine ${i}`).join('\n') + '\n'));
  {
    const broken = gzipSync(Array.from({ length: 10 }, (_, i) => `${t.toISOString()} bad ${i}`).join('\n') + '\n');
    broken[2] = 9;
    w(`badgz/${dp}/zz-broken.log.gz`, broken);
  }
  // SSM session transcript
  w(`ssm/sessions/session-abc123.log`, 'Script started on ' + t.toISOString() + '\nsh-4.2$ ls\nfile1 file2\nsh-4.2$ exit\n');
  // ALB converted to Parquet (scripts/alb-to-parquet.sh layout) and Flow Logs in Parquet (Hive prefixes)
  const albp = join(dataDir, 'bucket', 'alb-parquet', 'alb-app-dev', `dt=${dash}`, `hour=${hh}`);
  const flowp = join(
    dataDir,
    'bucket',
    'AWSLogs',
    'aws-account-id=123456789012',
    'aws-service=vpc',
    'aws-region=ap-northeast-1',
    `year=${t.getUTCFullYear()}`,
    `month=${pad(t.getUTCMonth() + 1)}`,
    `day=${pad(t.getUTCDate())}`,
    `hour=${hh}`,
  );
  mkdirSync(albp, { recursive: true });
  mkdirSync(flowp, { recursive: true });
  execSync(
    `duckdb -c "COPY (SELECT now()::TIMESTAMP - to_seconds(i) AS time, 'GET' AS method, (CASE WHEN i % 4 = 0 THEN 503 ELSE 200 END)::INT AS elb_status_code FROM range(40) t(i)) TO '${join(albp, 'data.parquet')}' (FORMAT PARQUET)"`,
    { stdio: 'inherit' },
  );
  execSync(
    `duckdb -c "COPY (SELECT 2 AS version, epoch(now())::BIGINT - i AS start, epoch(now())::BIGINT AS \\"end\\", CASE WHEN i % 5 = 0 THEN 'REJECT' ELSE 'ACCEPT' END AS action FROM range(30) t(i)) TO '${join(flowp, `123456789012_vpcflowlogs_ap-northeast-1_fl-0123456789abcdef0_${stamp}_hash.log.parquet`)}' (FORMAT PARQUET)"`,
    { stdio: 'inherit' },
  );
  // WAF (S3 delivery, minute folder), JSON lines with epoch-millisecond timestamp
  w(
    `AWSLogs/123456789012/WAFLogs/ap-northeast-1/my-acl/${dp}/${hh}/00/123456789012_waflogs_ap-northeast-1_my-acl_${stamp}_hash.log.gz`,
    gzipSync(
      Array.from({ length: 20 }, (_, i) =>
        JSON.stringify({
          timestamp: t.getTime() - i * 1000,
          action: i % 4 ? 'ALLOW' : 'BLOCK',
          webaclId: 'arn:aws:wafv2:ap-northeast-1:123456789012:regional/webacl/my-acl/1',
          httpRequest: { clientIp: `203.0.113.${i}`, uri: `/p/${i}`, httpMethod: 'GET' },
        }),
      ).join('\n') + '\n',
    ),
  );
  // Network Firewall alert logs, JSON lines with epoch-second string timestamp
  w(
    `AWSLogs/123456789012/network-firewall/alert/ap-northeast-1/fw-1/${dp}/${hh}/123456789012_network-firewall_alert_ap-northeast-1_fw-1_${stamp}_x.log.gz`,
    gzipSync(
      Array.from({ length: 12 }, (_, i) =>
        JSON.stringify({
          firewall_name: 'fw-1',
          availability_zone: 'ap-northeast-1a',
          event_timestamp: String(Math.floor(t.getTime() / 1000) - i),
          event: { src_ip: `10.0.0.${i}`, dest_port: 443, alert: { action: i % 3 ? 'allowed' : 'blocked', signature: 'sig' } },
        }),
      ).join('\n') + '\n',
    ),
  );
  // Route 53 Resolver query logs, JSON lines with ISO query_timestamp
  w(
    `AWSLogs/123456789012/vpcdnsquerylogs/vpc-0abc/${dp}/vpc-0abc_vpcdnsquerylogs_123456789012_${stamp}_hash.log.gz`,
    gzipSync(
      Array.from({ length: 15 }, (_, i) =>
        JSON.stringify({
          version: '1.100000',
          account_id: '123456789012',
          region: 'ap-northeast-1',
          vpc_id: 'vpc-0abc',
          query_timestamp: new Date(t.getTime() - i * 1000).toISOString(),
          query_name: `h${i}.example.com.`,
          query_type: 'A',
          rcode: i % 5 ? 'NOERROR' : 'NXDOMAIN',
          srcaddr: `10.0.0.${i}`,
        }),
      ).join('\n') + '\n',
    ),
  );
  // Kinesis Data Firehose default prefix: JSON records concatenated WITHOUT newlines
  w(
    `firehose/${dp}/${hh}/mystream-1-${stamp}-0123-uuid`,
    Array.from({ length: 10 }, (_, i) => JSON.stringify({ ts: new Date(t.getTime() - i * 1000).toISOString(), level: i % 2 ? 'info' : 'error', msg: `record ${i}` })).join(''),
  );
  // CloudWatch Logs export task: one folder per log stream, "timestamp message" lines
  w(`cwl-export/task-1/stream-a/000000.gz`, gzipSync(Array.from({ length: 8 }, (_, i) => `${new Date(t.getTime() - i * 1000).toISOString()} hello ${i}`).join('\n') + '\n'));
  w(`cwl-export/task-1/2026/09/11/[$LATEST]abc/000000.gz`, gzipSync(Array.from({ length: 3 }, (_, i) => `${new Date(t.getTime() - i * 1000).toISOString()} lambda ${i}`).join('\n') + '\n'));
}

// One run per port: the id goes into the server's environment and comes back from /__stats, so a
// server another run left behind (or a half-second that was not enough) is noticed here instead
// of showing up later as counters that do not add up.
const runId = `run-${process.pid}`;
const server = spawn(process.execPath, [new URL('./range-server.mjs', import.meta.url).pathname, dataDir, String(dataPort)], {
  stdio: 'inherit',
  env: { ...process.env, NOCORS: '1', DDV_RUN: runId },
});
let serverExited = null;
server.on('exit', (code) => (serverExited = code));
process.on('exit', () => server.kill());
const serverStats = async () => (await fetch(`http://localhost:${dataPort}/__stats`)).json();
for (let i = 0; ; i++) {
  if (serverExited !== null) throw new Error(`range-server exited with ${serverExited}; is port ${dataPort} already taken?`);
  const seen = await serverStats().catch(() => null);
  if (seen?.run === runId) break;
  if (i >= 50) throw new Error(seen ? `another range-server is already serving port ${dataPort}` : `range-server did not come up on port ${dataPort}`);
  await new Promise((r) => setTimeout(r, 100));
}

const { context, page, appUrl } = await launchExtension();
const base = appUrl;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`);
  if (!cond) failed++;
};
const swStats = () => page.evaluate(() => window.__ddv.cacheStats().then((r) => r.stats));
// Connect no longer counts rows for URL sources (it would read every footer); count explicitly.
const srcRows = () => page.evaluate(() => window.__ddv.query('SELECT count(*)::DOUBLE AS n FROM src').then((r) => Number(r.rows[0].n)));
const connectDone = (marker) =>
  page.waitForFunction(
    (m) =>
      (document.querySelector('.source-page button.connect')?.textContent ?? '').trim() === 'Connect' &&
      ([...document.querySelectorAll('.alert.ok')].some((e) => (e.textContent ?? '').includes(m)) || !!document.querySelector('.alert.error')),
    marker,
    { timeout: 60000 },
  );
/**
 * The element's text, or null when it is not on the page. Every caller has already waited for the
 * state it is about to read, so count() reports what is there; locator.textContent() would instead
 * auto-wait Playwright's full 30 s default for an element that is never going to appear.
 */
const textIfPresent = async (sel) => {
  const l = page.locator(sel);
  return (await l.count()) ? l.first().textContent() : null;
};
const errorAlert = () => textIfPresent('.alert.error');
/** Press Connect; if the pattern has {name} variables, select every listed value and press again. */
const pressConnect = async () => {
  await page.click('.source-page button:has-text("connect")');
  const settled = () => (document.querySelector('.source-page button.connect')?.textContent ?? '').trim().toLowerCase() !== 'connecting…';
  await page.waitForFunction(settled, null, { timeout: 120000 });
  const all = page.locator('.variables-box button:has-text("Select all values")');
  if (await all.count()) {
    await all.click();
    await page.click('.source-page button:has-text("Connect")');
  }
};
const openSource = async () => {
  await page.goto(base + '#/source');
  await waitReady(page);
  await page.waitForSelector('.source-page');
  // every section works with URL sources; the form may be on another kind when a section runs alone (SECTIONS=…)
  await page.click('.kinds button:has-text("S3 / HTTPS URL")');
};
const runQuery = async (q) => {
  await page.fill('.qinput input', q);
  await page.press('.qinput input', 'Enter');
  await settled(page);
  return page.textContent('.hits .n');
};

// Each section is one independent scenario: an exception ends that section (counted as a
// failure, with a screenshot) and the next one still runs. Later sections do not rely on state
// left by earlier ones beyond the fixtures on disk.
// SECTIONS=name,name runs only those (they are independent), e.g. while working on one of them.
const only = process.env.SECTIONS ? process.env.SECTIONS.split(',') : null;
const section = async (name, fn) => {
  if (only && !only.includes(name)) return;
  try {
    await fn();
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: exception ${e.message.split('\n')[0]}`);
    await page.screenshot({ path: `${out}/fail-cache-${name}.png` }).catch(() => undefined);
  }
};
let srv3;
let r;
let rows;
const q = (sql) =>
  page.evaluate(
    (x) =>
      window.__ddv
        .query(x)
        .then((r) => r.rows)
        .catch((e) => [{ error: String(e) }]),
    sql,
  );
const connectTemplate = async (label, urlsFix, marker) => {
  await openSource();
  await page.selectOption('.template-box select', { label });
  const warn = page.locator('.alert.warn button:has-text("Replace")');
  if (await warn.count()) await warn.click();
  const filled = urlsFix(await page.inputValue('.source-page textarea'));
  await page.fill('.source-page textarea', filled);
  await pressConnect();
  // wait for THIS connection's result (the previous source's card stays visible meanwhile)
  await page.waitForFunction(
    (m) =>
      (document.querySelector('.source-page button.connect')?.textContent ?? '').trim() === 'Connect' &&
      ([...document.querySelectorAll('.alert.ok')].some((e) => (e.textContent ?? '').includes(m)) || !!document.querySelector('.alert.error')),
    marker,
    { timeout: 60000 },
  );
  const err = await errorAlert();
  const tf = err ? null : await page.inputValue('.source-page .field-row:has-text("Time field") select');
  return { err, tf };
};
const bucketize = (u) => u.replace('<bucket>', 'bucket');
const connectPattern = async (urls, marker) => {
  await openSource();
  await page.fill('.source-page textarea', urls);
  await page.selectOption('.source-page .field-row:has-text("Format") select', 'auto');
  await page.click('.source-page button:has-text("Connect")');
  await page.waitForFunction(
    (m) =>
      (document.querySelector('.source-page button.connect')?.textContent ?? '').trim() === 'Connect' &&
      ([...document.querySelectorAll('.alert.ok')].some((e) => (e.textContent ?? '').includes(m)) || !!document.querySelector('.alert.error')),
    marker,
    { timeout: 60000 },
  );
  const err = await errorAlert();
  const tf = err ? null : await page.inputValue('.source-page .field-row:has-text("Time field") select');
  return { err, tf };
};

// The duckdb CLI writes the fixtures and duckdb-wasm reads them back, and they are separate
// releases: the CLI is pinned in .github/workflows/ci.yml, the engine comes with
// @duckdb/duckdb-wasm (1.32.0 runs DuckDB 1.4.3). A minor gap is fine, a major one means the
// fixture may use a format the engine cannot open — which would otherwise surface halfway
// through a section as an unreadable file rather than as a version problem.
await section('duckdb-versions', async () => {
  await openSource();
  const engine = String((await q('SELECT version() AS v'))[0]?.v ?? '');
  const cli = execSync('duckdb --version', { encoding: 'utf8' }).trim().split(/\s+/)[0];
  const major = (v) => v.replace(/^v/, '').split('.')[0];
  check('the duckdb CLI and duckdb-wasm share a major version', !!engine && major(cli) === major(engine), `CLI ${cli} writes, engine ${engine} reads`);
});

await section('opfs-and-http-parquet', async () => {
  await openSource();
  const ping = await page.evaluate(() => window.__ddv.cachePing());
  check('OPFS range cache available', !ping.opfsError, ping.opfsError ?? '');
  await page.evaluate(() => window.__ddv.cacheClear());

  // Connect to the parquet served over HTTP without CORS headers (host permission does the work).
  await page.click('.kinds button:has-text("S3 / HTTPS URL")');
  await page.fill('.source-page textarea', `http://localhost:${dataPort}/logs.parquet`);
  await page.click('.source-page button:has-text("Connect")');
  await connectDone('logs.parquet');
  const connected = await page.locator('.alert.ok', { hasText: 'logs.parquet' }).textContent();
  const connectedRows = await srcRows();
  check('connected over http', connectedRows === 600000, `${connected.trim()} rows=${connectedRows}`);
  await page.screenshot({ path: `${out}/20-cache-source.png` });

  await page.click('.header nav button:has-text("Discover")');
  await page.waitForSelector('.hits .n');
  const hits1 = await runQuery('status:>=500');
  const s1 = await swStats();
  const srv1 = await serverStats();
  check(
    'first query reads from origin',
    s1.bytesFromNetwork > 0 && srv1.bytesSent > 0,
    `network=${s1.bytesFromNetwork} cache=${s1.bytesFromCache} passthrough=${s1.passthrough} req=${s1.requests} hits=${hits1}`,
  );

  const hits2 = await runQuery('status:>=500 AND method:POST');
  const s2 = await swStats();
  const srv2 = await serverStats();
  check('second query served from cache', s2.bytesFromCache > 0 && s2.bytesFromNetwork === s1.bytesFromNetwork, `network=${s2.bytesFromNetwork} cache=${s2.bytesFromCache} hits=${hits2}`);
  check('origin bytes unchanged', srv2.bytesSent === srv1.bytesSent, `${srv1.bytesSent} -> ${srv2.bytesSent}`);

  // Reload: a fresh DuckDB worker must find the chunks in OPFS and read nothing from the origin.
  await page.reload();
  await page.waitForSelector('.hits .n', { timeout: 120000 });
  const hits3 = await runQuery('status:>=500');
  const s3 = await swStats();
  srv3 = await serverStats();
  check('after reload: served from disk cache', s3.bytesFromCache > 0 && s3.bytesFromNetwork === 0 && s3.chunkMisses === 0, `network=${s3.bytesFromNetwork} cache=${s3.bytesFromCache} hits=${hits3}`);
  check('after reload: origin bytes unchanged', srv3.bytesSent === srv2.bytesSent, `${srv2.bytesSent} -> ${srv3.bytesSent}`);
  // the fixture spans exactly the last 7 days, so the sliding window may move by a few rows
  const toN = (t) => Number(String(t).replace(/,/g, ''));
  check('results consistent', Math.abs(toN(hits1) - toN(hits3)) <= 20, `${hits1} vs ${hits3}`);

  // Cache panel renders.
  await page.click('.header nav button:has-text("Data source")');
  await page.waitForSelector('table.data');
  const row = await page.textContent('table.data tbody tr');
  check('cache panel lists file', row.includes('logs.parquet'), row.replace(/\s+/g, ' ').trim());
  await page.screenshot({ path: `${out}/21-cache-panel.png` });
});

await section('second-tab', async () => {
  // A second tab cannot own the cache (the first holds the lock) but opens the slab read-only:
  // it serves the chunks the first tab stored and keeps nothing of its own downloads.
  const tab2 = await context.newPage();
  await tab2.goto(base);
  await waitReady(tab2);
  await tab2.waitForSelector('.hits .n', { timeout: 120000 });
  await settled(tab2);
  const ping = await tab2.evaluate(() => window.__ddv.cachePing());
  const s2 = await tab2.evaluate(() => window.__ddv.cacheStats().then((r) => r.stats));
  check(
    'second tab shares the cache read-only',
    ping.readOnly === true && !ping.opfsError && s2.bytesFromCache > 0,
    `readOnly=${ping.readOnly} error=${ping.opfsError} cache=${s2.bytesFromCache} network=${s2.bytesFromNetwork}`,
  );
  const stored = await tab2.evaluate(() => window.__ddv.cacheFiles({ all: true }).then((r) => r.summary));
  const ownTotal = (await swStats()).bytesFromCache;
  await tab2.goto(base + '#/source');
  await tab2.waitForSelector('.cache-readonly', { timeout: 30000 });
  check('second tab says so on the Data source page', true, `index lists ${stored.cachedFiles} file(s); first tab served ${ownTotal} B from cache`);
  await tab2.close();
  // the first tab still owns the cache
  const ping1 = await page.evaluate(() => window.__ddv.cachePing());
  check('first tab still owns the cache', ping1.readOnly === false && !ping1.opfsError, `readOnly=${ping1.readOnly}`);
});

await section('cache-disabled', async () => {
  // Disable the cache and start a fresh DuckDB (reload): reads go to origin again.
  await page.evaluate(() => window.__ddv.cacheSetConfig({ enabled: false }));
  await page.reload();
  await waitReady(page);
  await page.click('.header nav button:has-text("Discover")');
  await page.waitForSelector('.hits .n', { timeout: 120000 });
  await runQuery('status:>=500 AND method:PUT');
  const srv4 = await serverStats();
  check('disabled cache reads from origin', srv4.bytesSent > srv3.bytesSent, `${srv3.bytesSent} -> ${srv4.bytesSent}`);
  await page.evaluate(() => window.__ddv.cacheSetConfig({ enabled: true }));
});

await section('cache-limit', async () => {
  // Two copies of the parquet under different URLs. The limit is set between one and two
  // per-query footprints, so the second file's chunks push the first one out (least recently
  // used). A reload gives each measurement a fresh DuckDB (it keeps read blocks in memory).
  await openSource();
  await page.evaluate(() => window.__ddv.cacheClear());
  await page.click('.kinds button:has-text("S3 / HTTPS URL")');
  await page.fill('.source-page textarea', `http://localhost:${dataPort}/logs.parquet\nhttp://localhost:${dataPort}/bucket/logs.parquet`);
  await page.click('.source-page button:has-text("Connect")');
  await connectDone('logs.parquet');
  const measure = async () => {
    await page.reload();
    await page.waitForSelector('.hits .n', { timeout: 120000 });
    await settled(page);
    return page.evaluate(() => window.__ddv.cacheFiles().then((r) => r.summary));
  };
  // the page switch must be in the URL before the reload (the hash is written after the render)
  await page.click('.header nav button:has-text("Discover")');
  await page.waitForSelector('.hits .n', { timeout: 120000 });
  await settled(page);
  const full = await measure();
  const limit = Math.floor(full.cachedBytes * 0.75);
  await page.evaluate((n) => window.__ddv.cacheSetConfig({ maxBytes: n }), limit);
  await page.evaluate(() => window.__ddv.cacheClear());
  const after = await measure();
  const st = await swStats();
  const cfg = await page.evaluate(() => window.__ddv.cacheStats().then((r) => r.config));
  check(
    'size limit drops the least recently used file',
    st.evictions >= 1 && after.cachedBytes <= limit && after.cachedFiles === 1,
    `two files: ${full.cachedBytes} B · limit ${limit} B · after: ${after.cachedBytes} B in ${after.cachedFiles} file(s), evictions=${st.evictions}`,
  );
  check('size limit survives a reload', cfg.maxBytes === limit, `config.maxBytes=${cfg.maxBytes}`);
  await page.evaluate(() => window.__ddv.cacheSetConfig({ maxBytes: 0 }));
});

await section('s3-static-keys', async () => {
  // S3-compatible access (path style, SigV4 signed by duckdb-wasm) with static keys.
  await openSource();
  await page.click('.kinds button:has-text("S3 / HTTPS URL")');
  await page.fill('.source-page textarea', 's3://bucket/logs.parquet');
  await page.fill('.source-page input[placeholder="s3.ap-northeast-1.amazonaws.com"]', `http://localhost:${dataPort}`);
  await page.selectOption('.source-page .field-row:has-text("URL style") select', 'path');
  await page.selectOption('.source-page .field-row:has-text("Authentication") select', 'static');
  await page.fill('.source-page .field-row:has-text("Access key ID") input', 'AKIAEXAMPLE');
  await page.fill('.source-page .field-row:has-text("Secret access key") input', 'secretexample');
  const srvBefore = await serverStats();
  await page.click('.source-page button:has-text("Connect")');
  await connectDone('s3://bucket/logs.parquet');
  const s3err = await errorAlert();
  const s3rows = s3err ? null : await srcRows();
  check('s3 path-style connect', !s3err && s3rows === 600000, s3err ?? `${(await page.locator('.alert.ok', { hasText: 's3://bucket/logs.parquet' }).textContent()).trim()} rows=${s3rows}`);
  await page.click('.header nav button:has-text("Discover")');
  await page.waitForSelector('.hits .n');
  const hitsS3 = await runQuery('status:>=500');
  const srvAfter = await serverStats();
  const swS3 = await swStats();
  const s3file = Object.keys(swS3.files).find((k) => k.includes('/bucket/logs.parquet'));
  check(
    's3 requests are SigV4 signed and go through the cache',
    srvAfter.signedRequests > srvBefore.signedRequests && !!s3file,
    `signed=${srvAfter.signedRequests - srvBefore.signedRequests} hits=${hitsS3} cachedFile=${s3file}`,
  );
});

await section('sts-credentials', async () => {
  // OIDC → STS mode: exchange a (fake) id_token at the fake STS endpoint, then connect with the
  // temporary credentials; requests must carry the session token. (The browser login itself
  // needs a real identity provider and is not covered here.)
  await openSource();
  // DuckDB keeps every block it has read in memory for the session, and the static-key queries
  // above read the whole of logs.parquet (its rows are in random time order, so no row group can
  // be skipped). The session token can only be observed on a file DuckDB has not seen: yesterday's
  // partition copy.
  const stsFile = `s3://bucket/AWSLogs/123456789012/parquet/ap-northeast-1/${dayPath(yesterday)}/part-${dayPath(yesterday).replace(/\//g, '')}.parquet`;
  await page.fill('.source-page textarea', stsFile);
  await page.selectOption('.source-page .field-row:has-text("Authentication") select', 'oidc');
  await page.fill('.source-page .field-row:has-text("IAM role ARN") input', 'arn:aws:iam::123456789012:role/test');
  await page.fill('.source-page .field-row:has-text("STS endpoint") input', `http://localhost:${dataPort}/sts`);
  const creds = await page.evaluate(async (port) => {
    const cfg = {
      authUrl: '',
      clientId: 'x',
      scope: 'openid',
      extraParams: '',
      roleArn: 'arn:aws:iam::123456789012:role/test',
      region: 'ap-northeast-1',
      stsEndpoint: `http://localhost:${port}/sts`,
      durationSeconds: 3600,
      sessionName: 'e2e',
    };
    const c = await window.__ddv.assumeRoleWithWebIdentity(cfg, 'fake.id.token');
    await window.__ddv.storeCredentials(c);
    return c;
  }, dataPort);
  check(
    'STS AssumeRoleWithWebIdentity parsed',
    creds.accessKeyId.startsWith('ASIATEST') && creds.sessionToken === 'session-token-from-sts' && !!creds.expiration,
    `${creds.accessKeyId} exp=${creds.expiration}`,
  );
  await page.evaluate(() => window.__ddv.cacheClear());
  const srvT0 = await serverStats();
  await page.click('.source-page button:has-text("Connect")');
  await connectDone(stsFile);
  const oidcErr = await errorAlert();
  const oidcRows = oidcErr ? null : await srcRows();
  check('connect with STS credentials', !oidcErr && oidcRows === 600000, oidcErr ?? `rows=${oidcRows}`);
  await page.click('.header nav button:has-text("Discover")');
  await page.waitForSelector('.hits .n');
  const stsHits = await runQuery('method:GET');
  const srvT1 = await serverStats();
  check(
    'requests carry x-amz-security-token',
    srvT1.tokenRequests > srvT0.tokenRequests,
    `token requests +${srvT1.tokenRequests - srvT0.tokenRequests} of ${srvT1.requests - srvT0.requests}, hits=${stsHits}`,
  );
  await page.screenshot({ path: `${out}/22-ext-source.png` });
});

await section('named-wildcards', async () => {
  // Named wildcards: {alb} becomes a column; an "is" filter on it prunes the file list.
  await page.click('.header nav button:has-text("Discover")');
  await page.waitForSelector('.timepicker .btn');
  await page.click('.timepicker .btn');
  await page.click('.quick-grid button:has-text("Last 7 days")');
  await settled(page);
  await openSource();
  await page.fill('.source-page textarea', 's3://bucket/AWSLogs/{account}/elasticloadbalancing/{region}/{yyyy}/{MM}/{dd}/{account}_elasticloadbalancing_{region}_app.{alb}.*.log.gz');
  await page.selectOption('.source-page .field-row:has-text("Authentication") select', 'static');
  await page.click('.source-page button:has-text("connect")');
  await page.waitForSelector('.variables-box .var-values', { timeout: 60000 });
  const varsText = (await page.textContent('.variables-box')).replace(/\s+/g, ' ');
  const albOpts = await page.locator('.var-values[data-token="alb"] .var-item').allTextContents();
  check(
    'pattern variables are listed before anything is read',
    /\{account\}/.test(varsText) &&
      /\{region\}/.test(varsText) &&
      albOpts.length === 2 &&
      albOpts.some((t) => /alb-app-dev/.test(t)) &&
      albOpts.some((t) => /alb-other/.test(t)) &&
      (await page.locator('.source-page button.connect').isDisabled()),
    `${albOpts.join(' | ')} connectDisabled=${await page.locator('.source-page button.connect').isDisabled()}`,
  );
  await page.click('.variables-box button:has-text("Select all values")');
  await page.click('.source-page button:has-text("Connect")');
  await page.waitForFunction(() => [...document.querySelectorAll('.alert.ok')].some((e) => /matched/.test(e.textContent ?? '')) || document.querySelector('.alert.error'), null, { timeout: 60000 });
  const nErr = await errorAlert();
  const nOk = nErr ? '' : await page.locator('.alert.ok', { hasText: 'matched' }).textContent();
  const albs = nErr ? [] : await page.evaluate(() => window.__ddv.query('SELECT alb, account, region, count(*) n, count(DISTINCT _file) files FROM src GROUP BY 1,2,3 ORDER BY 1').then((r) => r.rows));
  check(
    'named wildcards become columns',
    !nErr &&
      albs.length === 2 &&
      albs[0].alb === 'alb-app-dev' &&
      albs[0].account === '123456789012' &&
      albs[0].region === 'ap-northeast-1' &&
      Number(albs[0].files) === 3 &&
      albs[1].alb === 'alb-other',
    nErr ?? `${nOk.trim().slice(0, 60)}… ${JSON.stringify(albs)}`,
  );
  await page.click('.header nav button:has-text("Discover")');
  await page.waitForSelector('.hits .n');
  await runQuery(''); // the previous query referenced a field of the other source
  console.log(
    `     after clearing query: value=${JSON.stringify(await page.inputValue('.qinput input'))} errors=${await page.locator('.qerror').count()} ${(await textIfPresent('.qerror')) ?? ''} hits=${await page.textContent('.hits .n')} status=${await page.textContent('.header .status')}`,
  );
  await page.click('.field-item:has-text("alb")');
  await settled(page);
  console.log(`     details open: ${await page.locator('.field-details').count()} text=${((await textIfPresent('.field-details')) ?? '').slice(0, 120)}`);
  await page.waitForSelector('.topval', { timeout: 15000 });
  await page.locator('.topval', { hasText: 'alb-other' }).locator('.pm button').first().click();
  await settled(page);
  const prunedStatus = await page.textContent('.header .status');
  const prunedFiles = await page.evaluate(() => window.__ddv.query('SELECT count(DISTINCT _file) f, count(DISTINCT alb) a FROM src').then((r) => r.rows[0]));
  check(
    '"is" filter on a captured column prunes the file list',
    /2 file\(s\)/.test(prunedStatus) && Number(prunedFiles.f) === 2 && Number(prunedFiles.a) === 1,
    `${prunedStatus.trim()} ${JSON.stringify(prunedFiles)}`,
  );
  await page.click('.filterbar .pill button[title="Remove"]');
  await settled(page);
});

await section('date-tokens', async () => {
  // Glob + date tokens on S3: only the partitions inside the time range are listed and read.
  await page.click('.header nav button:has-text("Discover")');
  await page.waitForSelector('.timepicker .btn');
  await page.click('.timepicker .btn');
  await page.click('.quick-grid button:has-text("Last 7 days")');
  await settled(page);
  await openSource();
  await page.fill('.source-page textarea', 's3://bucket/AWSLogs/123456789012/parquet/ap-northeast-1/{yyyy}/{MM}/{dd}/*.parquet');
  await page.selectOption('.source-page .field-row:has-text("Authentication") select', 'static');
  await page.selectOption('.source-page .field-row:has-text("Format") select', 'auto');
  await page.click('.source-page button:has-text("Connect")');
  // The previous section's alert also says "matched", so wait for one naming a file of THIS source.
  await connectDone('parquet');
  const globErr = await errorAlert();
  const globOk = globErr ? '' : await page.locator('.alert.ok', { hasText: 'matched' }).textContent();
  const globRows = globErr ? null : await srcRows();
  check(
    'date-token glob lists only last-7-days partitions (2 of 3 files)',
    !globErr && /^2 file\(s\)(, [\d.]+ MB)? matched 1 pattern/.test(globOk.trim()) && globRows === 1200000,
    globErr ?? `${globOk.trim()} rows=${globRows}`,
  );
  await page.click('.header nav button:has-text("Discover")');
  await page.waitForSelector('.hits .n');
  await runQuery('status:>=500');
  // narrow the range to the last hour: the file list must be re-resolved. Partitions are UTC
  // days, so the expected file count is the number of UTC dates the last hour touches (1 or 2).
  await page.click('.timepicker .btn');
  await page.click('.quick-grid button:has-text("Last 60 minutes")');
  await settled(page);
  const utcDays = new Set([new Date(Date.now() - 3600_000).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10)]).size;
  const status = await page.textContent('.header .status');
  const rangeRows = await srcRows();
  check(
    `range change re-resolves the file list (${utcDays} UTC day(s) → ${600000 * utcDays} rows)`,
    status.includes(`${utcDays} file(s)`) && rangeRows === 600000 * utcDays,
    `${status.trim()} rows=${rangeRows}`,
  );
});

await section('alb-logs', async () => {
  // ALB access logs (.log.gz): format auto-detected from the path, columns typed.
  await page.click('.timepicker .btn');
  await page.click('.quick-grid button:has-text("Last 7 days")');
  await settled(page);
  await openSource();
  await page.fill(
    '.source-page textarea',
    's3://bucket/AWSLogs/123456789012/elasticloadbalancing/ap-northeast-1/{yyyy}/{MM}/{dd}/123456789012_elasticloadbalancing_ap-northeast-1_app.alb-app-dev.*.log.gz',
  );
  const srvC0 = await serverStats();
  await page.click('.source-page button:has-text("Connect")');
  await page.waitForFunction(() => [...document.querySelectorAll('.alert.ok')].some((e) => /log\.gz/.test(e.textContent ?? '')) || document.querySelector('.alert.error'), null, { timeout: 60000 });
  const albErr = await errorAlert();
  const srvC1 = await serverStats();
  check(
    'connect reads no log data (listing only)',
    srvC1.bytesSent === srvC0.bytesSent,
    `data bytes during connect: ${srvC1.bytesSent - srvC0.bytesSent}, requests: ${srvC1.requests - srvC0.requests}`,
  );
  check('connect issues no per-file HEAD (metadata seeded from the listing)', srvC1.headRequests === srvC0.headRequests, `HEAD during connect: ${srvC1.headRequests - srvC0.headRequests}`);
  const albOk = albErr ? '' : await page.locator('.alert.ok', { hasText: 'log.gz' }).textContent();
  const albFields = albErr ? [] : await page.evaluate(() => window.__ddv.query('DESCRIBE SELECT * FROM src').then((r) => r.rows.map((x) => x.column_name + ':' + x.column_type)));
  const albCount = albErr
    ? null
    : await page.evaluate(() => window.__ddv.query('SELECT count(*) n, count(*) FILTER (WHERE elb_status_code >= 500) e, min(time)::VARCHAR t, count(ip_address) ips FROM src').then((r) => r.rows[0]));
  const srvC2 = await serverStats();
  console.log(`     first full query read ${srvC2.bytesSent - srvC1.bytesSent} bytes in ${srvC2.requests - srvC1.requests} requests`);
  const swH = await swStats();
  check(
    'queries answer HEADs locally',
    srvC2.headRequests === srvC1.headRequests && swH.headsSynthesized > 0,
    `HEAD to origin during query: ${srvC2.headRequests - srvC1.headRequests}, synthesized so far: ${swH.headsSynthesized}`,
  );
  // alb-app-dev only: today 2 files (34 fields) + yesterday 1 file (30 fields) = 1500 lines; alb-other and the 40-day-old day are excluded
  check(
    'ALB logs: name prefix narrows the listing, 30/34-field files mixed, columns typed',
    !albErr &&
      albFields.length === 35 &&
      albFields.includes('_file:VARCHAR') &&
      albFields.includes('time:TIMESTAMP') &&
      albFields.includes('elb_status_code:INTEGER') &&
      Number(albCount?.n) === 1500 &&
      Number(albCount?.e) > 0 &&
      Number(albCount?.ips) === 1000,
    albErr ?? `${albOk.trim().slice(0, 80)}… fields=${albFields.length} rows=${JSON.stringify(albCount)}`,
  );
  // Last 1 hour: only the file stamped "now" survives the name-timestamp filter
  await page.click('.header nav button:has-text("Discover")');
  await page.waitForSelector('.hits .n');
  await page.click('.timepicker .btn');
  await page.click('.quick-grid button:has-text("Last 60 minutes")');
  await settled(page);
  const albStatus = await page.textContent('.header .status');
  const albFiles = await page.evaluate(() => window.__ddv.query('SELECT count(*) n FROM src').then((r) => r.rows[0].n));
  // the 00:00Z file is kept while now-1h-65min <= 00:00, i.e. before 02:05 UTC
  const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const expectPruned = nowMin < 125 ? 2 : 1;
  check(`ALB logs: name timestamps prune files outside the range (${expectPruned} file)`, Number(albFiles) === 500 * expectPruned, `${albStatus.trim()} rows=${albFiles}`);
});

await section('large-source-confirmation', async () => {
  // Large-source confirmation: with the threshold at 1 file, the 3 gz files of the last 7 days
  // must stop the connect BEFORE DuckDB is touched (no request at all), until the user continues.
  // A confirmed file set is not questioned again by the query-time download guard.
  await runQuery(''); // drop the query that referenced a field of another source
  await page.click('.timepicker .btn');
  await page.click('.quick-grid button:has-text("Last 7 days")');
  await settled(page);
  await openSource();
  await page.evaluate(() => window.__ddv.cacheClear());
  await page.waitForFunction(() => (document.querySelector('.source-page button.connect')?.textContent ?? '').trim() === 'Connect', null, { timeout: 60000 });
  await page.fill('.source-page .field-row:has-text("Warn when more files") input', '1');
  const srvL0 = await serverStats();
  await page.click('.source-page button:has-text("Connect")');
  const banner = page.locator('.connect-confirm');
  await banner.waitFor({ timeout: 60000 });
  const srvL1 = await serverStats();
  const confirmText = (await banner.textContent()).replace(/\s+/g, ' ').trim();
  check(
    'large source asks before touching DuckDB',
    /3 files/.test(confirmText) && /threshold 1/.test(confirmText) && srvL1.headRequests === srvL0.headRequests && srvL1.bytesSent === srvL0.bytesSent,
    `${confirmText.slice(0, 70)}… HEAD=${srvL1.headRequests - srvL0.headRequests} bytes=${srvL1.bytesSent - srvL0.bytesSent}`,
  );
  await banner.locator('button', { hasText: 'Cancel' }).click();
  await page.waitForFunction(() => /cancelled/i.test(document.querySelector('.alert.error')?.textContent ?? ''), null, { timeout: 15000 });
  check('cancelling the confirmation aborts the connect', (await banner.count()) === 0, await page.textContent('.alert.error'));
  await page.click('.source-page button:has-text("Connect")');
  await banner.waitFor({ timeout: 60000 });
  // the banner unmounts as soon as the click is handled: do not wait for it afterwards
  await banner.locator('button', { hasText: 'Continue' }).click({ noWaitAfter: true });
  await page.waitForFunction(
    () =>
      (document.querySelector('.source-page button.connect')?.textContent ?? '').trim() === 'Connect' &&
      [...document.querySelectorAll('.alert.ok')].some((e) => /3 file\(s\)/.test(e.textContent ?? '')),
    null,
    { timeout: 60000 },
  );
  await page.click('.header nav button:has-text("Discover")');
  await page.waitForFunction(() => !(document.querySelector('.hits .n')?.textContent ?? '…').includes('…'), null, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('.loading-bar'), null, { timeout: 60000 });
  const gateAfter = await page.evaluate(() => window.__ddv.gate?.status);
  const gateHits = await page.textContent('.hits .n');
  check(
    'after continuing, queries run without a second prompt',
    gateAfter === 'ok' && (await page.locator('.download-gate').count()) === 0 && /^\d/.test(gateHits.trim()),
    `gate=${gateAfter} hits=${gateHits}`,
  );
  // restore the default threshold in the saved source
  await openSource();
  await page.fill('.source-page .field-row:has-text("Warn when more files") input', '');
  await page.click('.source-page button:has-text("Connect")');
  await connectDone('log.gz');
});

await section('templates', async () => {
  // Templates for the other AWS log families: connect each and check the derived schema.
  // CloudTrail
  r = await connectTemplate('CloudTrail', bucketize, '_CloudTrail_');
  {
    await openSource();
    const before = await page.inputValue('.source-page textarea');
    await page.selectOption('.template-box select', { label: 'VPC Flow Logs' });
    const warned = await page.locator('.alert.warn').count();
    await page.click('.alert.warn button:has-text("Keep current")');
    const after = await page.inputValue('.source-page textarea');
    check('template dropdown warns before replacing an existing pattern', warned === 1 && before === after && before.includes('CloudTrail'), `warned=${warned} unchanged=${before === after}`);
  }
  rows = r.err ? null : await q('SELECT count(*) n, count(DISTINCT eventName) e, min(eventTime)::VARCHAR t, max(userIdentity.userName) u FROM src');
  check(
    'CloudTrail template: Records unnested, eventTime is the time field',
    !r.err && r.tf === 'eventTime' && Number(rows?.[0]?.n) === 2 && Number(rows?.[0]?.e) === 2 && rows?.[0]?.u === 'alice',
    r.err ?? `tf=${r.tf} ${JSON.stringify(rows)}`,
  );
  // VPC Flow Logs
  r = await connectTemplate('VPC Flow Logs', bucketize, '_vpcflowlogs_');
  rows = r.err ? null : await q("SELECT count(*) n, count(*) FILTER (WHERE action = 'REJECT') rej FROM src");
  check(
    'VPC Flow Logs template: header parsed, start is the time field',
    !r.err && r.tf === 'start' && Number(rows?.[0]?.n) === 50 && Number(rows?.[0]?.rej) === 10,
    r.err ?? `tf=${r.tf} ${JSON.stringify(rows)}`,
  );
  // CloudFront
  r = await connectTemplate('CloudFront logs', (u) => bucketize(u).replace('<prefix>', 'cf-logs'), 'cf-logs/');
  rows = r.err ? null : await q('SELECT count(*) n, count(*) FILTER (WHERE sc_status = 503) e, min("timestamp")::VARCHAR t, max(cs_uri_stem) p FROM src');
  check(
    'CloudFront template: TSV with header lines, derived timestamp',
    !r.err && r.tf === 'timestamp' && Number(rows?.[0]?.n) === 40 && Number(rows?.[0]?.e) === 6 && /^\d{4}-\d{2}-\d{2} \d{2}:00:00/.test(rows?.[0]?.t ?? ''),
    r.err ?? `tf=${r.tf} ${JSON.stringify(rows)}`,
  );
  // S3 server access logs
  r = await connectTemplate('S3 server access logs', (u) => bucketize(u).replace('<prefix>', 's3-logs'), 's3-logs/');
  rows = r.err ? null : await q('SELECT count(*) n, count(*) FILTER (WHERE http_status = 404) e, min("timestamp")::VARCHAR t, max(operation) o FROM src');
  check(
    'S3 access log template: bracketed time reassembled',
    !r.err && r.tf === 'timestamp' && Number(rows?.[0]?.n) === 30 && Number(rows?.[0]?.e) === 5 && rows?.[0]?.o === 'REST.GET.OBJECT',
    r.err ?? `tf=${r.tf} ${JSON.stringify(rows)}`,
  );
  // LTSV is a file format, not a delivery layout: no template, the pattern is typed directly
  r = await connectPattern('s3://bucket/ltsv/{yyyy}/{MM}/{dd}/*.ltsv.gz', 'ltsv/');
  const ltsvFields = r.err ? [] : (await q('DESCRIBE SELECT * FROM src')).map((x) => x.column_name);
  rows = r.err ? null : await q("SELECT count(*) n, count(*) FILTER (WHERE json_extract_string(log, '$.status') = '502') e FROM src");
  check(
    'LTSV template: labels become log.* fields, nginx time parsed',
    !r.err && r.tf === 'log.time' && Number(rows?.[0]?.n) === 25 && Number(rows?.[0]?.e) === 5,
    r.err ?? `tf=${r.tf} fields=${ltsvFields.join(',')} ${JSON.stringify(rows)}`,
  );
  await page.click('.header nav button:has-text("Discover")');
  await page.waitForSelector('.hits .n');
  const ltsvHits = await runQuery('log.status:502');
  check('LTSV: search on a log.* field', ltsvHits === '5', `hits=${ltsvHits}`);
  // SSM (plain lines)
  r = await connectTemplate('SSM session / command logs', (u) => bucketize(u).replace('<prefix>', 'ssm'), 'ssm/');
  rows = r.err ? null : await q('SELECT count(*) n, max(_file) f FROM src');
  check('SSM template: plain lines with _file', !r.err && Number(rows?.[0]?.n) === 4 && /session-abc123\.log$/.test(rows?.[0]?.f ?? ''), r.err ?? `${JSON.stringify(rows)}`);
  // ALB converted to Parquet (Hive dt= / hour= partitions, {alb} captured)
  r = await connectTemplate('ALB access logs converted to Parquet (scripts/alb-to-parquet.sh)', (u) => bucketize(u).replace('<prefix>', 'alb-parquet'), 'alb-parquet/');
  rows = r.err ? null : await q('SELECT count(*) n, count(*) FILTER (WHERE elb_status_code = 503) e, max(alb) alb, max(dt)::VARCHAR dt, max(hour) h FROM src');
  check(
    'ALB Parquet template: partition columns and {alb} capture',
    !r.err &&
      r.tf === 'time' &&
      Number(rows?.[0]?.n) === 40 &&
      Number(rows?.[0]?.e) === 10 &&
      rows?.[0]?.alb === 'alb-app-dev' &&
      /^\d{4}-\d{2}-\d{2}/.test(rows?.[0]?.dt ?? '') &&
      /^\d{2}$/.test(rows?.[0]?.h ?? ''),
    r.err ?? `tf=${r.tf} ${JSON.stringify(rows)}`,
  );
  // VPC Flow Logs in Parquet (Hive-compatible prefixes)
  r = await connectTemplate('VPC Flow Logs (Parquet, Hive-compatible prefixes)', bucketize, 'aws-service=vpc');
  rows = r.err ? null : await q("SELECT count(*) n, count(*) FILTER (WHERE action = 'REJECT') rej, max(account) a, max(region) rg FROM src");
  check(
    'Flow Logs Parquet template: start is the time field, account / region captured',
    !r.err && r.tf === 'start' && Number(rows?.[0]?.n) === 30 && Number(rows?.[0]?.rej) === 6 && rows?.[0]?.a === '123456789012' && rows?.[0]?.rg === 'ap-northeast-1',
    r.err ?? `tf=${r.tf} ${JSON.stringify(rows)}`,
  );
  // WAF
  r = await connectTemplate('WAF logs (S3 delivery)', bucketize, '_waflogs_');
  rows = r.err ? null : await q("SELECT count(*) n, count(*) FILTER (WHERE action = 'BLOCK') b, max(webacl) w, max(httpRequest.uri) u FROM src");
  check(
    'WAF template: minute folder globbed, timestamp (epoch ms) is the time field',
    !r.err && r.tf === 'timestamp' && Number(rows?.[0]?.n) === 20 && Number(rows?.[0]?.b) === 5 && rows?.[0]?.w === 'my-acl' && rows?.[0]?.u === '/p/9',
    r.err ?? `tf=${r.tf} ${JSON.stringify(rows)}`,
  );
  // Network Firewall
  r = await connectTemplate('Network Firewall logs', bucketize, 'network-firewall/');
  rows = r.err ? null : await q("SELECT count(*) n, max(log_type) lt, max(firewall) fw, count(*) FILTER (WHERE event.alert.action = 'blocked') b FROM src");
  check(
    'Network Firewall template: log_type / firewall captured, event_timestamp is the time field',
    !r.err && r.tf === 'event_timestamp' && Number(rows?.[0]?.n) === 12 && rows?.[0]?.lt === 'alert' && rows?.[0]?.fw === 'fw-1' && Number(rows?.[0]?.b) === 4,
    r.err ?? `tf=${r.tf} ${JSON.stringify(rows)}`,
  );
  // Route 53 Resolver
  r = await connectTemplate('Route 53 Resolver query logs', bucketize, 'vpcdnsquerylogs/');
  rows = r.err ? null : await q("SELECT count(*) n, count(*) FILTER (WHERE rcode = 'NXDOMAIN') nx, max(vpc) v FROM src");
  check(
    'Route 53 Resolver template: query_timestamp is the time field, vpc captured',
    !r.err && r.tf === 'query_timestamp' && Number(rows?.[0]?.n) === 15 && Number(rows?.[0]?.nx) === 3 && rows?.[0]?.v === 'vpc-0abc',
    r.err ?? `tf=${r.tf} ${JSON.stringify(rows)}`,
  );
  // Kinesis Data Firehose (concatenated JSON without newlines)
  r = await connectTemplate('Kinesis Data Firehose delivery (default prefix)', (u) => bucketize(u).replace('<prefix>', 'firehose'), 'firehose/');
  rows = r.err ? null : await q("SELECT count(*) n, count(*) FILTER (WHERE level = 'error') e, min(ts)::VARCHAR t FROM src");
  check('Firehose template: concatenated JSON records read', !r.err && r.tf === 'ts' && Number(rows?.[0]?.n) === 10 && Number(rows?.[0]?.e) === 5, r.err ?? `tf=${r.tf} ${JSON.stringify(rows)}`);
  // CloudWatch Logs export (stream folders, including one with slashes in the stream name)
  r = await connectTemplate('CloudWatch Logs export to S3', (u) => bucketize(u).replace('<prefix>', 'cwl-export').replace('<task-id>', 'task-1'), 'cwl-export/');
  rows = r.err ? null : await q('SELECT count(*) n, count(DISTINCT _file) f, max(message) m, count("timestamp") ts FROM src');
  check(
    'CloudWatch Logs export template: timestamp split from message, all streams read',
    !r.err && r.tf === 'timestamp' && Number(rows?.[0]?.n) === 11 && Number(rows?.[0]?.f) === 2 && rows?.[0]?.m === 'lambda 2' && Number(rows?.[0]?.ts) === 11,
    r.err ?? `tf=${r.tf} ${JSON.stringify(rows)}`,
  );
});

await section('concatenated-gzip', async () => {
  // ---- concatenated gzip: DuckDB reads these itself and silently drops rows at member boundaries ----
  // The 3 fixtures hold 3000 + 20000 + 100 = 23100 lines. DuckDB's gzip reader only continues into
  // the next member when the read that filled its 32 KB buffer was a full one (duckdb
  // src/common/compressed_file_system.cpp) and otherwise closes the file where the footer sits
  // (gzip_file_system.cpp, "Only footer is available"), so a short read at a boundary ends the file
  // early with no error. This check records that loss; it fails once DuckDB stops dropping rows,
  // which is the signal to convert it into an equality assertion.
  const TOTAL = 3000 + 20000 + 100;
  await openSource();
  await page.fill('.source-page textarea', 's3://bucket/multigz/{yyyy}/{MM}/{dd}/*.log.gz');
  await page.selectOption('.source-page .field-row:has-text("Format") select', 'lines');
  await pressConnect();
  await page.waitForFunction(() => (document.querySelector('.source-page button.connect')?.textContent ?? '').trim() === 'Connect', null, { timeout: 120000 });
  const multiErr = await errorAlert();
  const multiRows = await q('SELECT count(*) n FROM src');
  const got = Number(multiRows?.[0]?.n);
  check(
    'concatenated gzip: read directly, rows are lost at member boundaries (known DuckDB behaviour)',
    !multiErr && got > 0 && got < TOTAL,
    multiErr ?? `${got} of ${TOTAL} rows (${TOTAL - got} lost); equal to ${TOTAL} means DuckDB fixed it`,
  );
  const cachedM = (await page.evaluate(() => window.__ddv.cacheFiles({ all: true }))).files.filter((f) => /multigz/.test(f.url));
  check(
    'concatenated gzip: the objects are cached as the origin serves them',
    cachedM.length === 3 && cachedM.every((f) => f.cachedBytes > 0),
    JSON.stringify(cachedM.map((f) => [f.url.split('/').pop(), f.size, f.cachedBytes])),
  );
});

await section('damaged-gzip', async () => {
  // ---- damaged gz: the query fails, "Find the failing file" isolates and inspects the culprit ----
  await openSource();
  await page.fill('.source-page textarea', 's3://bucket/badgz/{yyyy}/{MM}/{dd}/*.log.gz');
  await page.selectOption('.source-page .field-row:has-text("Format") select', 'lines');
  await pressConnect();
  await page.waitForFunction(() => (document.querySelector('.source-page button.connect')?.textContent ?? '').trim() === 'Connect', null, { timeout: 60000 });
  const badErr = await errorAlert();
  const badCount = await q('SELECT count(*) n FROM src');
  check('damaged gz: connect succeeds, count(*) reports the GZIP error', !badErr && /GZIP/i.test(badCount?.[0]?.error ?? ''), badErr ?? JSON.stringify(badCount).slice(0, 160));
  await page.click('.header nav button:has-text("Discover")');
  await page.fill('.qinput input', ''); // an earlier test left a query that no longer compiles
  await page.press('.qinput input', 'Enter');
  await page.waitForSelector('.diagnose button', { timeout: 60000 });
  const qerr = await page.textContent('.qerror');
  await page.click('.diagnose button:has-text("Find the failing file")');
  await page.waitForSelector('.diagnose-report', { timeout: 120000 });
  const diag = await page.evaluate(() => JSON.parse(document.querySelector('.diag-json').value));
  const culprit = diag.failing?.[0];
  check(
    'damaged gz: diagnosis names the file and reads its header',
    /GZIP/i.test(qerr) &&
      diag.failing?.length === 1 &&
      /zz-broken\.log\.gz$/.test(culprit?.file ?? '') &&
      culprit?.head?.startsWith('1f8b09') &&
      /method 9/.test(culprit?.gzip?.verdict ?? '') &&
      culprit?.readSize === culprit?.listedSize,
    `queries=${diag.queries} failing=${JSON.stringify(diag.failing?.map((f) => [f.file.split('/').pop(), f.head, f.gzip?.verdict]))}`,
  );
  const logRow = (await swStats()).log.find((l) => l.method === 'GET' && /zz-broken/.test(l.url) && l.head);
  check('request log records status, size and first bytes per request', !!logRow && logRow.status === 206 && logRow.head.startsWith('1f8b09') && logRow.bytes > 0, JSON.stringify(logRow));
  await page.click('.header nav button:has-text("Data source")');
  await page.click('.cache-log-box summary');
  const logText = await page.textContent('.cache-log-box summary');
  check('cache panel shows the request log', /Request log \(last \d+/.test(logText), logText.trim());
});

if (errors.length) console.log('console errors:', errors.slice(0, 10));
await context.close();
server.kill();
process.exit(failed ? 1 : 0);
