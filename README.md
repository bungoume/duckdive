# Duckdive

A Chrome extension that searches and charts log files. It reads Parquet, CSV and JSON from S3 or S3-compatible storage, from HTTPS URLs, or from local files, and queries them in the browser. Nothing is sent anywhere else.

Three pages:

- Discover: query bar, time histogram, document table, field sidebar, filter pills.
- Visualize: area, line, bar, table and metric charts with date histograms, break-downs and top values. Clicking a chart adds a filter or zooms the time range.
- Data source: where the files are, how they are formatted, which field is the time, and how to authenticate.

## Why an extension

An extension can read from a bucket without any change to the bucket's configuration. It can sign in at your identity provider and obtain temporary AWS credentials on its own, so no long-lived keys are stored anywhere. Data that has been read once is kept on the machine and reused.

## Build and install

```
npm install
npm run build      # writes dist/
npm run pack       # writes release/duckdive-<version>.zip
npm run icons      # regenerates icons and store images from assets/logo.svg
```

Open `chrome://extensions`, enable Developer mode, choose "Load unpacked" and select `dist/`. The toolbar button opens the app. `npm run dev` rebuilds `dist/` on every change; reload the extension afterwards.

The extension ID is `kohchgcbcmdcoondpjoiaccfkhadkpki`. The manifest carries the Web Store's public key so an unpacked build gets the same ID; `npm run pack` removes the key from the zip because the store rejects it.

## Data sources

The Data source page accepts one of:

- `s3://bucket/...` patterns, one per line
- `https://...` URLs (presigned or served through CloudFront)
- local Parquet, CSV or JSON files (read through the File API, never uploaded)
- a built-in demo dataset

### Patterns

The extension lists the bucket itself and expands the pattern into a file list. A pattern may contain:

- wildcards: `*`, `?`, `**`, `[abc]`
- date tokens `{yyyy}` `{MM}` `{dd}` `{HH}`, expanded from the time picker (UTC). Only partitions inside the range are listed. Changing the range re-lists.
- named tokens such as `{account}`, `{region}`, `{alb}`. Pressing Connect lists the newest partition, shows each token's values with counts, and asks you to pick one or more before connecting. The chosen values become part of the listing prefix, and the matched text becomes a column of the same name. The original object key is in `_file`.

Examples:

```
s3://my-alb-logs/AWSLogs/123456789012/elasticloadbalancing/ap-northeast-1/{yyyy}/{MM}/{dd}/123456789012_elasticloadbalancing_ap-northeast-1_app.my-alb.*.log.gz
s3://my-alb-logs/AWSLogs/{account}/elasticloadbalancing/{region}/{yyyy}/{MM}/{dd}/{account}_elasticloadbalancing_{region}_app.{alb}.*.log.gz
s3://my-bucket/events/dt={yyyy}-{MM}-{dd}/*.parquet
```

Everything before the first wildcard is used as the S3 prefix, so put as much of the file name in the pattern as you can when a date folder holds files from many load balancers. Files whose names contain a timestamp (`_20260909T0105Z_`, as in ALB and NLB logs) are dropped when they fall outside the time range. Listing needs the `s3:ListBucket` permission; see `docs/iam-role-policy.json`. `https://` URLs support date tokens only.

The Template menu fills in the pattern and format for the usual AWS layouts: ALB, NLB, CloudFront, CloudTrail, VPC Flow Logs (text and Parquet), WAF, Network Firewall, Route 53 Resolver, S3 server access logs, Kinesis Data Firehose, CloudWatch Logs exports and SSM session logs. Replace `<bucket>` and `<prefix>` with your own values.

### Formats

Auto-detection goes by path and extension. Parquet, CSV and JSON are read with DuckDB's own readers (gzip and zstd included). Fixed layouts are recognised for ALB access logs, CloudFront standard logs, CloudTrail (`Records` expanded to one row per event), VPC Flow Logs (columns from the header line), S3 server access logs, LTSV (labels exposed as `log.<label>`), CloudWatch Logs exports and plain text (one row per line). String time fields are parsed as ISO 8601, nginx/Apache format, or epoch seconds/milliseconds.

Gzip files cannot be read partially, so each `.gz` object is fetched in full. Narrow the date range, or convert to hourly Parquet with `scripts/alb-to-parquet.sh` (DuckDB CLI only).

AWS log delivery sometimes writes gzip files as several concatenated members, which cannot be read reliably as-is. At connect time the extension downloads listed `.gz` objects, re-packs such files into a single member and keeps the copy in the cache. This can be turned off under Local range cache.

### Large listings

Connecting to ten thousand files costs only the listing; no per-file requests are made. If more files than the threshold (default 1000) or more than 512 MB match, the extension stops and asks before creating the view. A second check before each query counts files that have nothing in the cache yet and shows the expected download.

### Hosts

`https://*.amazonaws.com/*` is granted at install. Any other host (MinIO, R2, CloudFront, localhost) triggers Chrome's permission prompt when you connect. Granted hosts are listed on the Data source page and can be revoked there.

Leaving the endpoint empty produces `https://<bucket>.s3.amazonaws.com/<key>`. A regional endpoint such as `s3.ap-northeast-1.amazonaws.com` produces virtual-hosted URLs. An `http://` or `https://` endpoint produces path-style URLs for S3-compatible services.

### Authentication

Sign in (OIDC) → STS is the intended mode. Create an OAuth client at your identity provider with `https://kohchgcbcmdcoondpjoiaccfkhadkpki.chromiumapp.org/` as the redirect URI (`response_type=id_token` must be allowed). Register the provider in IAM and create a role that trusts it; see `docs/iam-role-trust-policy.json` and `docs/README.md`. Enter the authorization endpoint, client ID and role ARN on the Data source page. Temporary credentials live in `chrome.storage.session` and are refreshed ten minutes before they expire.

Access key mode stores an IAM user's keys in the extension's localStorage. Use a read-only policy. None is for public buckets and presigned URLs.

## Query syntax

The query bar uses Lucene syntax.

| Example | Meaning |
| --- | --- |
| `error timeout` | free text; each word matches any searchable field, words are OR-ed |
| `"connection reset"` | phrase; `"a b"~3` requires all words in the same field |
| `http.status:503` | field match (exact for numbers and booleans, token match for strings) |
| `host.name:web-*` | wildcard; `?` matches one character |
| `path:/api\/v[12]\/.*/` | regular expression |
| `http.status:(500 OR 503)` | list of values |
| `http.latency_ms:>800` | range; `:>` `:>=` `:<` `:<=` |
| `http.bytes:[1000 TO 5000]` | bracket range; `{}` excludes the bound, `*` leaves it open |
| `extra.user_id:*` | field exists |
| `NOT level:info`, `-level:info` | negation; `+term` requires |
| `a AND (b OR c)` | `AND` `OR` `NOT` in upper case, or `&&` `||` `!`; adjacent terms are OR-ed |

Special characters are escaped with `\`. `term~2` and `term^3` are accepted and ignored. Struct columns are addressed with dots (`geo.country`); JSON columns are sampled for keys and exposed the same way (`extra.user_id`). "show SQL" displays the generated statement.

## Range cache

`src/worker/duckdb-cache-worker.ts` wraps the duckdb-wasm worker and replaces its `XMLHttpRequest`. Range requests are aligned to chunks (1 MB by default) and stored in one append-only file in OPFS with a JSON index. Chunks are dropped when the object's ETag changes. Presigned-URL parameters are excluded from the cache key. DuckDB extensions are cached too, so later starts work offline. Only one tab can hold the cache at a time; a second tab runs without it.

duckdb-wasm downloads whole HTTP files by default. `src/duck.ts` opens the database with `reliableHeadRequests: true` and `allowFullHTTPReads: false` to force range reads.

## Tests

```
npm test               # builds with localhost allowed, then runs both suites
node e2e/smoke.mjs     # Discover and Visualize on the demo dataset
node e2e/cache.mjs     # permissions, OPFS persistence, SigV4 and STS against a local range server
```

`e2e/cache.mjs` needs the `duckdb` CLI to generate fixtures. Both use Playwright's headless Chromium with the built extension loaded.

## Layout

```
vite.config.ts                     manifest generation
src/background.ts                  toolbar button
src/worker/duckdb-cache-worker.ts  XHR replacement, OPFS cache, duckdb-wasm worker
src/auth.ts                        OIDC login and STS
src/permissions.ts                 host permissions
src/datasource.ts, s3list.ts       listing, pattern expansion, view creation
src/search.ts, sql.ts, queries.ts  query compilation
src/components/                    UI
scripts/                           duckdb-wasm bundling, icons, packaging, ALB to Parquet
docs/                              IAM examples, privacy policy
e2e/                               Playwright tests and the local range server
```

## Limits

- Full-text search is a regular expression with word boundaries, not an analyzer.
- DuckDB-Wasm is single-threaded and limited to under 4 GB of memory. Use the time range and partitions to keep scans small.
- Saved visualizations and settings are in the extension's localStorage. The URL carries the query and chart definition, so links work for anyone with the extension installed.
- Chrome and Edge only.

## License

MIT. Licenses of bundled packages are written to `THIRD_PARTY_LICENSES.txt` in `dist/` at build time. The privacy policy is in `docs/PRIVACY.md`.
