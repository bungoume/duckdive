// Actual CloudTrail JSON/gzip, OTel and Parquet with precise API/category drill-downs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { launchExtension, waitReady, settled } from './ext-context.mjs';

const fixtures = mkdtempSync(join(tmpdir(), 'ddv-cloudtrail-analysis-'));
mkdirSync(join(fixtures, 'CloudTrail'));
const logPath = 'CloudTrail/events.json.gz';
const records = [];
const alice = {
  type: 'IAMUser',
  arn: 'arn:aws:iam::111111111111:user/alice',
  accountId: '111111111111',
  userName: 'alice',
};
const role = {
  type: 'AssumedRole',
  arn: 'arn:aws:sts::111111111111:assumed-role/deploy/session-1',
  accountId: '111111111111',
  principalId: 'ROLE:session-1',
};
const root = { type: 'Root', arn: 'arn:aws:iam::111111111111:root', accountId: '111111111111' };
const add = (service, name, identity, extra = {}) =>
  records.push({
    eventVersion: '1.11',
    eventTime: '2026-09-22T12:00:00Z',
    eventType: 'AwsApiCall',
    eventSource: `${service}.amazonaws.com`,
    eventName: name,
    userIdentity: identity,
    eventID: `event-${records.length}`,
    awsRegion: 'us-east-1',
    ...extra,
  });
add('ec2', 'DescribeInstances', alice);
add('ec2', 'DescribeInstances', alice, { errorCode: 'AccessDenied' });
add('iam', 'AttachRolePolicy', alice);
add('iam', 'AttachRolePolicy', alice, { errorCode: 'AccessDenied', errorMessage: 'Denied' });
add('iam', 'CreateAccessKey', role, { errorMessage: 'Denied' });
add('cloudtrail', 'StopLogging', role);
add('s3', 'ListBuckets', { type: 'IAMUser', accountId: '111111111111', userName: "o'connor" });
add(
  's3',
  'ListBuckets',
  { type: 'IAMUser', accountId: '222222222222', userName: "o'connor" },
  { errorCode: 'AccessDenied' },
);
add('s3', 'GetObject', null);
add('ec2', 'DescribeInstances', root);
add('iam', 'UpdateAssumeRolePolicy', root);
add('ec2', 'AuthorizeSecurityGroupIngress', role);
add('unrelated', 'AttachRolePolicy', role);
add('ec2', 'AttachRolePolicy', role);
add('s3', 'GetObject', null, { errorCode: '  ', errorMessage: '' });
add('s3', 'ListBuckets', null, { errorCode: '', eventTime: '2026-09-23T00:00:00Z' });
add('signin', 'ConsoleLogin', root, { eventType: 'AwsConsoleSignIn', errorCode: 'Denied' });
add('iam', 'AttachRolePolicy', alice, { eventType: 'AwsServiceEvent' });
add('s3', 'GetObject', null, { eventType: 'AwsVpceEvents', errorCode: 'VpceAccessDenied' });
add('iam', 'AttachRolePolicy', alice, { eventType: null });
add('iam', 'AttachRolePolicy', alice, { errorCode: 'Denied', eventTime: '2026-09-21T23:59:59Z' });
add('iam', 'AttachRolePolicy', alice, { errorCode: 'Denied', eventTime: '2026-09-23T00:00:01Z' });
writeFileSync(join(fixtures, logPath), gzipSync(JSON.stringify({ Records: records })));
writeFileSync(
  join(fixtures, 'success.jsonl'),
  JSON.stringify({
    eventTime: '2026-09-22T12:00:00Z',
    eventType: 'AwsApiCall',
    eventSource: 's3.amazonaws.com',
    eventName: 'ListBuckets',
  }) + '\n',
);
const importantNames = [
  'AttachUserPolicy',
  'AttachGroupPolicy',
  'AttachRolePolicy',
  'DetachUserPolicy',
  'DetachGroupPolicy',
  'DetachRolePolicy',
  'PutUserPolicy',
  'PutGroupPolicy',
  'PutRolePolicy',
  'DeleteUserPolicy',
  'DeleteGroupPolicy',
  'DeleteRolePolicy',
];
writeFileSync(
  join(fixtures, 'ranking.jsonl'),
  importantNames
    .map((eventName, i) =>
      JSON.stringify({
        eventType: 'AwsApiCall',
        eventSource: 'iam.amazonaws.com',
        eventName,
        'userIdentity.principalId': `id-${i}`,
        'userIdentity.accountId': '111111111111',
      }),
    )
    .join('\n') + '\n',
);
const server = spawn(process.execPath, [new URL('./range-server.mjs', import.meta.url).pathname, fixtures, '0'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
let context;
let page;
try {
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => {
      const m = /localhost:(\d+)/.exec(String(d));
      if (m) resolve(Number(m[1]));
    });
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Fixture server exited: ${code}`)));
  });
  const app = await launchExtension();
  context = app.context;
  page = app.page;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await waitReady(page);
  await settled(page);
  const baseSearch = { query: '', filters: [], range: { from: '2026-09-22T00:00:00Z', to: '2026-09-23T00:00:00Z' } };
  const cfg = {
    kind: 'url',
    name: 'CloudTrail fixtures',
    urls: `http://localhost:${port}/${logPath}`,
    format: 'auto',
    naming: 'native',
    timeField: null,
    authMode: 'none',
  };
  let navigation = 0;
  const open = async (config = cfg, target = 'discover') => {
    await page.evaluate((config) => localStorage.setItem('ddv.source', JSON.stringify(config)), config);
    await page.goto(
      `${app.appUrl}?ct=${++navigation}#/${target}?s=${Buffer.from(JSON.stringify({ search: baseSearch })).toString('base64url')}`,
    );
    await waitReady(page);
    await settled(page);
  };
  const search = async (query = '', range = baseSearch.range, filters = []) => {
    await page.goto(
      `${app.appUrl}?ct=${navigation}#/discover?s=${Buffer.from(JSON.stringify({ search: { query, range, filters } })).toString('base64url')}`,
    );
    await settled(page);
  };
  const metric = (id) => page.locator(`.analysis-metric[data-metric="${id}"] .analysis-value`);
  const row = (kind, label) =>
    page
      .locator(`[data-ranking="${kind}"] tbody tr`)
      .filter({ has: page.locator('td:first-child', { hasText: label }) });
  const hits = () => page.locator('.hits .n').textContent();
  const drill = async (kind, label, count, failed = false) => {
    await row(kind, label)
      .getByRole('button', { name: failed ? /View API error logs:/ : 'View logs', exact: !failed })
      .click();
    await settled(page);
    assert.equal(await hits(), String(count), `${kind}: ${label}`);
    assert.equal(await page.locator('table.docs > tbody > tr').count(), count);
  };
  const assertMetrics = async () => {
    assert.equal(await metric('errors').textContent(), '25.00%');
    assert.equal(await metric('important').textContent(), '7');
    assert.match(await page.locator('.analysis-template').innerText(), /4 errors \/ 16 API call records/);
    assert.match(await page.locator('.analysis-template').innerText(), /4 non-API or unclassified records excluded/);
    assert.deepEqual((await row('user', alice.arn).locator('td').allTextContents()).slice(1, 3), ['4', '2']);
    assert.deepEqual(
      (await row('api', 'iam.amazonaws.com / AttachRolePolicy').locator('td').allTextContents()).slice(1, 3),
      ['2', '1'],
    );
    assert.equal(await row('user', "111111111111 / o'connor").count(), 1);
    assert.equal(await row('user', "222222222222 / o'connor").count(), 1);
    assert.match(await page.locator('[data-ranking="user"] tbody tr').first().innerText(), /deploy\/session-1/);
    assert.equal(await row('important', 'AttachRolePolicy').count(), 1);
    assert.match(await row('important', 'UpdateAssumeRolePolicy').innerText(), /Permissions/);
    assert.match(await row('important', 'DescribeInstances').innerText(), /Other root activity/);
  };
  await open(cfg, 'source');
  await page.locator('.source-page button.connect').click();
  await settled(page);
  assert.match(page.url(), /#\/discover/);
  assert.equal(await page.locator('.analysis-template').getAttribute('aria-label'), 'CloudTrail analysis template');
  await assertMetrics();
  assert.equal(await page.evaluate(() => localStorage.getItem('ddv.savedVis')), null);
  console.log(
    'ok CloudTrail: automatic analysis, API denominator, error messages, important operations and identities',
  );

  await page.getByRole('button', { name: 'View API error logs', exact: true }).click();
  await settled(page);
  assert.equal(await hits(), '4');
  await search();
  await page.getByRole('button', { name: 'View important operation logs', exact: true }).click();
  await settled(page);
  assert.equal(await hits(), '7');
  await search();
  await drill('user', alice.arn, 4);
  await search();
  await drill('user', "222222222222 / o'connor", 1, true);
  await search();
  await drill('user', 'Unknown user', 3);
  await search();
  await drill('api', 'iam.amazonaws.com / AttachRolePolicy', 2);
  await search();
  await drill('important', 'iam.amazonaws.com / AttachRolePolicy', 1, true);
  await search();
  await drill('important', 'DescribeInstances', 1);
  await search('eventSource:iam.amazonaws.com', baseSearch.range, [
    { id: 'actor', field: 'userIdentity.arn', op: 'is', value: alice.arn },
  ]);
  await drill('user', alice.arn, 2);
  assert.equal(await page.locator('.qinput input').inputValue(), 'eventSource:iam.amazonaws.com');
  await search('eventType:AwsConsoleSignIn');
  assert.equal(await metric('errors').textContent(), '—');
  assert.equal(await metric('important').textContent(), '0');
  await search('', { from: '2026-09-22T00:00:00Z', to: '2026-09-22T10:00:00Z' });
  assert.equal(await metric('errors').textContent(), '—');
  assert.equal(await page.locator('.trail-table').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'View API error logs', exact: true }).isDisabled(), true);
  console.log(
    'ok CloudTrail: exact user/API/category/error drills, unknown users, query/filter/range preservation, empty results',
  );

  await search();
  await page.getByRole('button', { name: 'Hide analysis', exact: true }).click();
  await settled(page);
  await page.evaluate(() => window.__ddv.getQueryLog().splice(0));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settled(page);
  assert.equal(
    await page.evaluate(() => window.__ddv.getQueryLog().some((q) => q.sql.includes('trail_rankings'))),
    false,
  );
  await page.getByRole('button', { name: 'Show analysis', exact: true }).click();
  await settled(page);
  await assertMetrics();
  await page.evaluate(() => window.__ddv.getQueryLog().splice(0));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settled(page);
  assert.equal(
    await page.evaluate(() => window.__ddv.getQueryLog().filter((q) => q.sql.includes('trail_rankings')).length),
    1,
  );
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.locator('.export-menu select').selectOption('parquet');
  const download = page.waitForEvent('download');
  await page.locator('.export-menu').getByRole('button', { name: 'Download', exact: true }).click();
  await (await download).saveAs(join(fixtures, 'converted.parquet'));
  await open({ ...cfg, urls: `http://localhost:${port}/converted.parquet`, format: 'parquet' });
  await assertMetrics();
  await open({ ...cfg, naming: 'otel' });
  await assertMetrics();
  await drill('important', 'iam.amazonaws.com / AttachRolePolicy', 2);
  await page.reload();
  await waitReady(page);
  await settled(page);
  assert.equal(await hits(), '2');
  assert.equal(await metric('errors').textContent(), '50.00%');
  await open({ ...cfg, urls: `http://localhost:${port}/success.jsonl`, format: 'json' });
  assert.equal(await metric('errors').textContent(), '0.00%');
  assert.equal(await metric('important').textContent(), '0');
  await drill('user', 'Unknown user', 1);
  await open({ ...cfg, urls: `http://localhost:${port}/ranking.jsonl`, format: 'json' });
  assert.equal(await metric('important').textContent(), '12');
  for (const kind of ['user', 'api', 'important'])
    assert.equal(await page.locator(`[data-ranking="${kind}"] tbody tr`).count(), 10);
  assert.match(await page.locator('.analysis-template').innerText(), /analyzing all matching records/);
  await page.getByRole('button', { name: 'View important operation logs', exact: true }).click();
  await settled(page);
  assert.equal(await hits(), '12');
  console.log(
    'ok CloudTrail: collapse/refresh, Parquet, OTel, trusted restore, optional fields, independent ranking limits',
  );

  await open(cfg);
  await page.setViewportSize({ width: 1000, height: 900 });
  await settled(page);
  assert.equal(
    await page.locator('.analysis-template').evaluate((panel) => panel.scrollWidth <= panel.clientWidth + 1),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  if (process.env.DDV_CLOUDTRAIL_SCREENSHOT) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.lang-select').selectOption('ja');
    await page.getByRole('button', { name: 'Discover', exact: true }).click();
    await settled(page);
    mkdirSync(new URL('../release/e2e/', import.meta.url), { recursive: true });
    await page.screenshot({ path: new URL('../release/e2e/cloudtrail-analysis.png', import.meta.url).pathname });
  }
  await page.locator('.src-select').selectOption('demo');
  await settled(page);
  assert.equal(await page.locator('.analysis-template').count(), 0);
  assert.deepEqual(errors, []);
  console.log('ok CloudTrail: responsive layout, source switch and no browser errors');
} catch (error) {
  if (page) {
    mkdirSync(new URL('../release/e2e/', import.meta.url), { recursive: true });
    await page
      .screenshot({ path: new URL('../release/e2e/cloudtrail-analysis-failure.png', import.meta.url).pathname })
      .catch(() => undefined);
    console.log((await page.locator('.analysis-template').allTextContents()).join('\n'));
  }
  throw error;
} finally {
  await context?.close();
  server.kill();
  rmSync(fixtures, { recursive: true, force: true });
}
