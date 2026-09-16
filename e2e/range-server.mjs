// Tiny static file server with HTTP Range + CORS support, standing in for S3 in tests.
//   node e2e/range-server.mjs <dir> <port>
import { createServer } from 'node:http';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join, normalize, relative } from 'node:path';

/** Minimal ListObjectsV2 over a directory (path-style: GET /<bucket>/?list-type=2&prefix=&delimiter=). */
function listObjectsV2(bucketDir, bucket, prefix, delimiter, maxKeys, startAfter) {
  const all = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else all.push(relative(bucketDir, full).split('\\').join('/'));
    }
  };
  try {
    walk(bucketDir);
  } catch {
    return null;
  }
  all.sort();
  const contents = [];
  const prefixes = new Set();
  for (const key of all) {
    if (!key.startsWith(prefix)) continue;
    if (startAfter && key <= startAfter) continue;
    const rest = key.slice(prefix.length);
    if (delimiter) {
      const i = rest.indexOf(delimiter);
      if (i >= 0) {
        prefixes.add(prefix + rest.slice(0, i + 1));
        continue;
      }
    }
    contents.push(key);
  }
  const page = contents.slice(0, maxKeys);
  const truncated = contents.length > maxKeys;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>`;
  if (truncated) xml += `<NextContinuationToken>${esc(page[page.length - 1])}</NextContinuationToken>`;
  for (const key of page) {
    const st = statSync(join(bucketDir, key));
    xml += `<Contents><Key>${esc(key)}</Key><LastModified>${st.mtime.toISOString()}</LastModified><ETag>"${st.size}-${Math.floor(st.mtimeMs)}"</ETag><Size>${st.size}</Size></Contents>`;
  }
  for (const p of prefixes) xml += `<CommonPrefixes><Prefix>${esc(p)}</Prefix></CommonPrefixes>`;
  return xml + '</ListBucketResult>';
}

const dir = process.argv[2] ?? '.';
const port = Number(process.argv[3] ?? 5299);
// NOCORS=1: behave like a bucket without any CORS configuration (no Access-Control-* headers).
const noCors = process.env.NOCORS === '1';
let requests = 0;
let bytesSent = 0;
let signedRequests = 0;
let tokenRequests = 0;
let headRequests = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__stats') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ requests, bytesSent, signedRequests, tokenRequests, headRequests }));
    return;
  }
  const cors = noCors
    ? {}
    : {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        // like S3 with AllowedHeaders ["*"]: echo whatever the browser asks for (covers Authorization)
        'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
        'access-control-expose-headers': 'Content-Range, Content-Length, ETag, Accept-Ranges',
      };
  if (req.method === 'OPTIONS') {
    res.writeHead(noCors ? 403 : 204, cors);
    res.end();
    return;
  }
  // ListObjectsV2 (path style)
  if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
    const bucket = url.pathname.replace(/^\/|\/$/g, '');
    const xml = listObjectsV2(
      join(dir, bucket),
      bucket,
      url.searchParams.get('prefix') ?? '',
      url.searchParams.get('delimiter') ?? '',
      Number(url.searchParams.get('max-keys') ?? 1000),
      url.searchParams.get('continuation-token') ?? '',
    );
    requests++;
    if (req.headers.authorization && /^AWS4-HMAC-SHA256/.test(req.headers.authorization) && req.headers['x-amz-date']) signedRequests++;
    if (!xml) {
      res.writeHead(404, { ...cors, 'content-type': 'application/xml' });
      res.end('<Error><Code>NoSuchBucket</Code><Message>no such bucket</Message></Error>');
      return;
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/xml' });
    res.end(xml);
    return;
  }
  // Fake STS endpoint for AssumeRoleWithWebIdentity (tests only).
  if (url.pathname === '/sts') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      const ok = p.get('Action') === 'AssumeRoleWithWebIdentity' && p.get('RoleArn') && p.get('WebIdentityToken');
      if (!ok) {
        res.writeHead(400, { 'content-type': 'application/xml' });
        res.end('<ErrorResponse><Error><Code>InvalidParameter</Code><Message>missing parameters</Message></Error></ErrorResponse>');
        return;
      }
      const exp = new Date(Date.now() + Number(p.get('DurationSeconds') || 3600) * 1000).toISOString();
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult>
  <SubjectFromWebIdentityToken>user@example.com</SubjectFromWebIdentityToken>
  <Credentials><AccessKeyId>ASIATEST${p.get('RoleSessionName')}</AccessKeyId><SecretAccessKey>secret-from-sts</SecretAccessKey><SessionToken>session-token-from-sts</SessionToken><Expiration>${exp}</Expiration></Credentials>
</AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`);
    });
    return;
  }
  const file = join(dir, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ''));
  let st;
  try {
    st = statSync(file);
  } catch {
    res.writeHead(404, cors);
    res.end('not found');
    return;
  }
  requests++;
  if (process.env.LOG_HEADERS)
    console.log(
      'REQ',
      req.method,
      req.url,
      JSON.stringify({
        range: req.headers.range,
        origin: req.headers.origin,
        referer: req.headers.referer,
        dest: req.headers['sec-fetch-dest'],
        mode: req.headers['sec-fetch-mode'],
        site: req.headers['sec-fetch-site'],
        ua: (req.headers['user-agent'] || '').slice(0, 40),
      }),
    );
  if (req.headers.authorization && /^AWS4-HMAC-SHA256/.test(req.headers.authorization) && req.headers['x-amz-date']) signedRequests++;
  if (req.headers['x-amz-security-token']) tokenRequests++;
  if (req.method === 'HEAD') headRequests++;
  const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
  const base = { ...cors, 'accept-ranges': 'bytes', etag, 'content-type': 'application/octet-stream' };
  const range = req.headers.range;
  if (req.method === 'HEAD' && !range) {
    res.writeHead(200, { ...base, 'content-length': st.size });
    res.end();
    return;
  }
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      res.writeHead(416, base);
      res.end();
      return;
    }
    let start = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
    let end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) {
      res.writeHead(416, { ...base, 'content-range': `bytes */${st.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...base, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}` });
    if (req.method === 'HEAD') {
      res.end(); // like S3: HEAD with Range answers 206 without a body
      return;
    }
    bytesSent += end - start + 1;
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  bytesSent += st.size;
  res.writeHead(200, { ...base, 'content-length': st.size });
  createReadStream(file).pipe(res);
});

server.listen(port, () => console.log(`range-server serving ${dir} on http://localhost:${port}`));
