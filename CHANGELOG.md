# Changelog

All notable changes to Duckdive. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Error banners show the message alone (no `Error:` prefix), and a request that timed out is described in the UI language.
- A render error shows a message with a Reload button instead of a blank page.
- The Data source page warns when a destination is plain `http://` (localhost excepted).
- Form labels are linked to their controls, so screen readers announce them and clicking a label focuses the field.

### Internal

- ESLint checks hook dependencies (`react-hooks`) and unhandled promises (type-aware rules); `tsc` covers `test/` and the config files.
- Translation keys built from interval, format and template ids are checked at compile time; event handlers read `e.currentTarget`; repeated lists carry keys.
- `sources.ts` (source settings and history) split out of `state.ts`; `store.ts` behind `useSettings` / `useLang`; `errors.ts` with `describeError()`.
- Recurring inline styles replaced with classes; hidden source maps next to the bundles (left out of the store zip); `pnpm run test:coverage`; `engines.node >= 22`.

## [0.2.0] - 2026-09-17

### Changed (behaviour)

- Static access keys: the secret access key and the session token are kept in `chrome.storage.session` only (memory, cleared when the browser closes). After a restart the Data source page shows the key ID and asks for the secret again. The access key ID stays with the source settings.
- Custom SQL filters that arrive through a shared URL are restored disabled and marked ⚠ until you open them, read the SQL and enable them. SQL written or reviewed in this browser is remembered in `localStorage` (`ddv.trustedSql`).
- Histogram buckets follow the time zone chosen in Settings (daily buckets start at that zone's midnight, monthly ones on the 1st, weekly ones on the configured first day of the week) instead of the browser's zone. Month and year buckets render with their real length.
- Temporary STS credentials are refreshed ten minutes before they expire, as documented; a refresh that fails shows a banner pointing to the Data source page.
- The test hooks on `window.__ddv` exist only in dev builds and in builds made with `VITE_DDV_DEBUG=1` (`pnpm run build:e2e`); store builds publish nothing on the page.

### Fixed

- A key without wildcards (`s3://bucket/key.gz`) is listed too, so it gets a size and ETag and concatenated gzip objects given by their exact key are re-packed.
- A range or filter change made while a connect was running was lost; it is now applied as soon as that connect ends.
- A range request whose object changed on the server mid-assembly restarts against the new version instead of mixing old and new bytes.
- Filters comparing a number field with a word no longer fail the query at run time.
- The document table's expanded rows are reset by a new search; "show SQL" shows the document query rather than whatever ran last.
- A malformed link (a range without an end, columns that are not a list, an unknown chart type) no longer blanks the page: every field falls back to its default.
- The smoke test exits non-zero when a step fails.

### Performance

- A search scans the source once instead of three or four times: the histogram provides the count, the field sidebar's totals come from a window function, and Visualize computes its top-N and aggregation from one materialised projection. For gzip sources each avoided scan is one decompression of every file.
- Re-packed gzip copies are transferred to the cache worker instead of copied; the worker's index is saved at most five seconds after a change; the SigV4 signing key is derived once per day, region and key; HEAD answers synthesised from the listing stay valid for six hours.

### Internal

- App split into `useConnect`, `useDownloadGate` and `useCredentialRefresh`; `attachSource` and the Data source page split into steps and section components; the cache worker's pure helpers moved to `cache-util.ts`.
- Vitest unit tests for the pure modules, ESLint + Prettier, a CI workflow with pinned actions, Renovate, CodeQL and a security policy; pnpm with exact, hash-pinned dependencies.
- The UI is localised in seven languages including the previously hard-coded labels; icon controls carry accessible names and are keyboard operable.

## [0.1.1] - 2026-09-16

- Multilingual UI with Settings, recent data sources and a readable time axis.

## [0.1.0] - 2026-09-14

- First release: search and visualise S3 logs in the browser with DuckDB-Wasm.
