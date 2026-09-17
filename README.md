# Duckdive

A Chrome extension that searches and charts log files. It reads Parquet, CSV and JSON from S3 or S3-compatible storage, from HTTPS URLs, or from local files, and queries them in the browser. Nothing is sent anywhere else.

Four pages:

- Discover: query bar, time histogram, document table, field sidebar, filter pills, export of the matching rows.
- Visualize: area, line, bar, table and metric charts with date histograms, break-downs and top values. Clicking a chart adds a filter or zooms the time range.
- Data source: where the files are, how they are formatted, which field is the time, and how to authenticate.
- Settings: UI language, date format, time zone, scaled date format for histogram buckets, first day of the week, and the time picker's quick ranges.

## Why an extension

An extension can read from a bucket without any change to the bucket's configuration. It can sign in at your identity provider and obtain temporary AWS credentials on its own, so no long-lived keys are stored anywhere. Data that has been read once is kept on the machine and reused.

## Build and install

```
pnpm install
pnpm run build      # writes dist/
pnpm run pack       # writes release/duckdive-<version>.zip
pnpm run icons      # regenerates icons and store images from assets/logo.svg
pnpm run build:e2e  # build with the test hooks and localhost allowed (for the e2e tests and screenshots)
```

`package.json#packageManager` pins the pnpm version and the hash of its tarball, so `pnpm` resolves to that exact release through Corepack (0.34.7 or newer for pnpm 12) or pnpm's own version management. `pnpm-workspace.yaml` sets a 7-day cooldown (`minimumReleaseAge`): a version published more recently is never installed, transitive dependencies included, and `pnpm-lock.yaml` pins every package by its integrity hash. pnpm also refuses a release whose publish evidence is weaker than an earlier one (`trustPolicy: no-downgrade`). `SECURITY.md` describes how to report a vulnerability. `renovate.json` opens update PRs with the same cooldown and keeps the GitHub Actions pinned to commit SHAs.

Open `chrome://extensions`, enable Developer mode, choose "Load unpacked" and select `dist/`. The toolbar button opens the app. `pnpm run dev` rebuilds `dist/` on every change; reload the extension afterwards.

The extension ID is `kohchgcbcmdcoondpjoiaccfkhadkpki`. The manifest carries the Web Store's public key so an unpacked build gets the same ID; `pnpm run pack` removes the key from the zip because the store rejects it.

## Languages

The UI is available in English, Japanese, Simplified Chinese, Korean, German, French and Spanish. The language follows Chrome's UI language on first start and can be changed on the Settings page; the choice is kept in this browser (`localStorage`, key `ddv.lang`). English is the fallback for unknown locales.

Strings live in `src/i18n/<lang>.ts`, one flat dictionary per language typed against `src/i18n/en.ts`, so a missing key is a compile error. `t('key', { n })` fills `{n}` placeholders; `tx()` does the same when a placeholder is a JSX node. The extension name and store description come from `public/_locales/<lang>/messages.json` (each description must stay within the store's 132-character limit; `pnpm run pack` checks it). To add a language: copy `en.ts`, register it in `src/i18n/index.ts` (`LANGS` and the dictionary table) and add a `_locales` folder. Field names, SQL, pattern examples, DuckDB / STS error messages, the diagnose report's technical verdicts and the Visualize panel's function vocabulary (Function, Minimum interval, Date histogram / Top values / Intervals, Count / Sum / Average / … ) stay in English on purpose.

## Settings

The Settings page keeps preferences in this browser (`localStorage`, key `ddv.settings`); "Reset to defaults" removes them.

- Date format: a moment-style pattern (`YYYY-MM-DDTHH:mm:ss.SSS` by default) for every displayed date. Tokens: `YYYY YY MMMM MMM MM M DD D dddd ddd d HH H hh h mm m ss s SSS SS S A a Z ZZ X x`, `[text]` for literals.
- Time zone: an IANA name; empty means the browser's zone. It applies to displayed dates, the absolute time picker, date-math rounding (`now/d` is midnight in that zone) and histogram buckets (daily and longer buckets start at that zone's midnight, monthly ones on the 1st). Buckets use the zone's offset at the end of the time range, so a range that spans a DST change is off by one hour on its far side. Date tokens in S3 patterns stay in UTC.
- Scaled date format: `[ISO 8601 duration, pattern]` pairs. Chart tooltips and table cells of date histograms use the pattern of the largest duration not above the bucket size (`""` covers sub-second buckets). Axis labels are not configurable: ticks sit on wall-clock boundaries of the display time zone, are spaced so that they never overlap, and show only what the visible range needs (no date within a single day, no year within a single year, no time for daily and longer steps).
- Day of week: the first day of the week for `now/w` and weekly buckets (Monday by default).
- Time filter quick ranges: `{"from", "to", "display"}` entries in date-math syntax for the time picker's "Commonly used" list. Without `display` the label is generated in the UI language.

## Data sources

The Data source page accepts one of:

- `s3://bucket/...` patterns, one per line
- `https://...` URLs (presigned or served through CloudFront)
- local Parquet, CSV or JSON files or folders, dropped on the page or chosen in the file dialog (read through the File API, never uploaded)
- a built-in demo dataset

### Recent sources

Every successful connect to an S3 / HTTPS or demo source is remembered (up to 20, newest first, in this browser's `localStorage` under `ddv.sources`, including the access key ID and chosen pattern values; secret keys are kept for the browser session only, see Authentication). The drop-down in the header switches between them from any page; the Data source page lists them with Connect and Remove buttons. Two configurations are the same entry when their destination matches (kind, URL lines, endpoint, region, URL style and authentication mode); name, format and time field are updated in place. Switching keeps the time range and the query, and drops filters, columns, sorts and chart fields that name a field the new source does not have. Local sources are remembered through their file handles (IndexedDB, `ddv-local`): after a restart Chrome asks for permission to read them again when you connect. Files of a folder are registered under their path below it, so equal names in different sub-folders stay apart.

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

Everything before the first wildcard is used as the S3 prefix, so put as much of the file name in the pattern as you can when a date folder holds files from many load balancers. Files whose names contain a timestamp (`_20260909T0105Z_`, as in ALB and NLB logs) are dropped when they fall outside the time range. Listing needs the `s3:ListBucket` permission; see `docs/iam-role-policy.json`. A key without wildcards is listed too (one request) so that its size and ETag feed the cache and the gzip re-packing; when that listing is denied the key is used as typed. `https://` URLs support date tokens only.

The Template menu fills in the pattern and format for the usual AWS layouts: ALB, NLB, CloudFront, CloudTrail, VPC Flow Logs (text and Parquet), WAF, Network Firewall, Route 53 Resolver, S3 server access logs, Kinesis Data Firehose, CloudWatch Logs exports and SSM session logs. Replace `<bucket>` and `<prefix>` with your own values.

### Formats

Auto-detection goes by path and extension. Parquet, CSV and JSON are read with DuckDB's own readers (gzip and zstd included). Fixed layouts are recognised for ALB access logs, CloudFront standard logs, CloudTrail (`Records` expanded to one row per event), VPC Flow Logs (columns from the header line), S3 server access logs, LTSV (labels exposed as `log.<label>`), CloudWatch Logs exports and plain text (one row per line). String time fields are parsed as ISO 8601, nginx/Apache format, or epoch seconds/milliseconds.

Gzip files cannot be read partially, so each `.gz` object is fetched in full. Narrow the date range, or convert to hourly Parquet with `scripts/alb-to-parquet.sh` (DuckDB CLI only).

AWS log delivery sometimes writes gzip files as several concatenated members, which cannot be read reliably as-is. At connect time the extension downloads listed `.gz` objects, re-packs such files into a single member and keeps the copy in the cache. This can be turned off under Local range cache.

### Large listings

Connecting to ten thousand files costs only the listing; no per-file requests are made (except for JSON-typed columns, whose keys are sampled from up to 500 values at connect time, and for JSON sources, which DuckDB binds with `union_by_name`). If more files than the threshold (default 1000) or more than 512 MB match, the extension stops and asks before creating the view. A second check before each query counts files that have nothing in the cache yet and shows the expected download.

### Hosts

`https://*.amazonaws.com/*` is granted at install. Any other host (MinIO, R2, CloudFront, localhost) triggers Chrome's permission prompt when you connect. Granted hosts are listed on the Data source page and can be revoked there.

Leaving the endpoint empty produces `https://<bucket>.s3.amazonaws.com/<key>`. A regional endpoint such as `s3.ap-northeast-1.amazonaws.com` produces virtual-hosted URLs. An `http://` or `https://` endpoint produces path-style URLs for S3-compatible services.

### Authentication

Sign in (OIDC) → STS is the intended mode. Create an OAuth client at your identity provider with `https://kohchgcbcmdcoondpjoiaccfkhadkpki.chromiumapp.org/` as the redirect URI (`response_type=id_token` must be allowed). Register the provider in IAM and create a role that trusts it; see `docs/iam-role-trust-policy.json` and `docs/README.md`. Enter the authorization endpoint, client ID and role ARN on the Data source page. Temporary credentials live in `chrome.storage.session` and are refreshed ten minutes before they expire.

Access key mode keeps the access key ID with the source configuration and the secret access key / session token in `chrome.storage.session` only, i.e. in memory until the browser closes; after a restart the Data source page shows the key ID and asks for the secret again. Use a read-only policy. None is for public buckets and presigned URLs.

## Query syntax

The query bar uses Lucene syntax.

| Example                         | Meaning                                                               |
| ------------------------------- | --------------------------------------------------------------------- |
| `error timeout`                 | free text; each word matches any searchable field, words are OR-ed    |
| `"connection reset"`            | phrase; `"a b"~3` requires all words in the same field                |
| `http.status:503`               | field match (exact for numbers and booleans, token match for strings) |
| `host.name:web-*`               | wildcard; `?` matches one character                                   |
| `path:/api\/v[12]\/.*/`         | regular expression                                                    |
| `http.status:(500 OR 503)`      | list of values                                                        |
| `http.latency_ms:>800`          | range; `:>` `:>=` `:<` `:<=`                                          |
| `http.bytes:[1000 TO 5000]`     | bracket range; `{}` excludes the bound, `*` leaves it open            |
| `extra.user_id:*`               | field exists                                                          |
| `NOT level:info`, `-level:info` | negation; `+term` requires                                            |
| `a AND (b OR c)`                | `AND` `OR` `NOT` in upper case, or `&&` `                             |     | ` `!`; adjacent terms are OR-ed |

Special characters are escaped with `\`. `term~2` and `term^3` are accepted and ignored. Struct columns are addressed with dots (`geo.country`); JSON columns are sampled for keys and exposed the same way (`extra.user_id`). "show SQL" displays the generated statement.

Filters of the type "custom SQL" run verbatim inside DuckDB. Because the URL carries the filters, a link from someone else could contain SQL that reads this extension's S3 credentials or reaches the network; such filters are restored disabled and marked with ⚠ until you open them, read the SQL and enable them (SQL written or reviewed in this browser is remembered in `localStorage`, key `ddv.trustedSql`).

## Export

"Export" on the Discover page downloads the rows that match the query, the filters and the time range as CSV, JSON Lines or Parquet, sorted like the table and cut at the chosen number of rows (10,000 by default, at most 1,000,000). With columns selected the file holds the time column and those columns under their field names; without a selection it holds every column of the source, so a gzip ALB prefix can be turned into a Parquet file from the browser. DuckDB writes the file in memory before the download starts, so keep the row limit within what the tab can hold. The Visualize page's table has its own "Download CSV".

## Sharing a view

"Share" in the header copies a link to the current page: query, filters, time range, columns, chart definition and, as a separate `src` parameter, the data source without any secret (URL lines, format, region, endpoint, authentication mode, identity provider settings, role ARN, chosen pattern values and time field; never an access key ID or a secret). On the receiving side a source that was connected in that browser before is connected right away; an unknown one is shown in a banner with its destination, endpoint and authentication mode and connected only when Connect is pressed. Static keys and a sign-in are still entered by the recipient. Local files cannot travel in a link, and custom SQL filters arrive disabled (see Query syntax).

## Range cache

`src/worker/duckdb-cache-worker.ts` wraps the duckdb-wasm worker and replaces its `XMLHttpRequest`; the page controls the cache over a `MessagePort` handed to the worker as its first message (`src/cache.ts`), so re-packed gzip copies are transferred rather than copied. Range requests are aligned to chunks (1 MB by default) and stored in one append-only file in OPFS with a JSON index. Chunks are dropped when the object's ETag changes. Presigned-URL parameters are excluded from the cache key. DuckDB extensions are cached too, so later starts work offline. Only one tab can hold the cache at a time; a second tab runs without it.

duckdb-wasm downloads whole HTTP files by default. `src/duck.ts` opens the database with `reliableHeadRequests: true` and `allowFullHTTPReads: false` to force range reads.

## Tests

```
pnpm test              # typecheck, lint, unit tests, then the e2e build and both Playwright suites
pnpm run test:unit     # vitest: query parser, date math, ticks, patterns, gzip members, SQL, URL state, formats, cache helpers, secrets
pnpm run test:coverage # the same with a coverage report (coverage/index.html)
pnpm run lint          # eslint + prettier --check   (pnpm run format rewrites)
pnpm run build:e2e     # the e2e build alone (VITE_DDV_DEBUG=1, http://localhost/* allowed)
node e2e/smoke.mjs     # Discover and Visualize on the demo dataset
node e2e/cache.mjs     # permissions, OPFS persistence, SigV4 and STS against a local range server
```

The unit tests in `test/` run in Node against the pure modules (with Web Storage and `location` stubbed in `test/setup.ts`); everything that needs DuckDB or Chrome is covered by the Playwright suites. `.github/workflows/ci.yml` runs the same steps on every push and pull request.

`e2e/cache.mjs` needs the `duckdb` CLI to generate fixtures. Both use Playwright's headless Chromium with the built extension loaded and drive the app through `window.__ddv`, hooks that exist only in dev builds and in builds made with `VITE_DDV_DEBUG=1` (`src/debug.ts`); a store build publishes nothing on the page. The tests assert English text, so `e2e/ext-context.mjs` pins the UI language to English before the page loads; set `DDV_LANG=ja` (or another language id) to run `pnpm run screenshots` (after `pnpm run build:e2e`) in that language.

## Layout

```
vite.config.ts                     manifest generation
src/background.ts                  toolbar button
src/worker/duckdb-cache-worker.ts  XHR replacement, OPFS cache, duckdb-wasm worker
src/cache.ts, duck.ts              cache control port, DuckDB session and query queue
src/auth.ts, secrets.ts            OIDC login and STS; session-only static keys
src/permissions.ts                 host permissions
src/datasource.ts, s3list.ts       listing, pattern expansion, view creation
src/search.ts, sql.ts, queries.ts  query compilation
src/hooks/                         connect life cycle, download gate, credential refresh
src/components/                    UI (components/source/: the Data source page's sections)
src/state.ts, sources.ts           URL state and saved charts; source settings and history
src/store.ts, errors.ts            store helper behind useSettings / useLang; error text
src/trust.ts, debug.ts             custom-SQL trust list; test hooks (e2e builds only)
test/                              vitest unit tests for the pure modules
scripts/                           duckdb-wasm bundling, icons, packaging, ALB to Parquet
docs/                              IAM examples, privacy policy
e2e/                               Playwright tests and the local range server
```

## Limits

- Full-text search is a regular expression with word boundaries, not an analyzer.
- DuckDB-Wasm is single-threaded and limited to under 4 GB of memory. Use the time range and partitions to keep scans small.
- Saved visualizations and settings are in the extension's localStorage. The URL carries the query and chart definition, and "Share" adds the data source, so links work for anyone with the extension installed.
- Chrome and Edge only.

## Changelog

See `CHANGELOG.md`.

## License

MIT. Licenses of bundled packages are written to `THIRD_PARTY_LICENSES.txt` in `dist/` at build time. The privacy policy is in `docs/PRIVACY.md`.
