---
name: verify
description: Drive the built extension in Chromium to check a change end to end - the two Playwright suites, how to run one section of them, and the traps that make a run look like an app bug. Read before running or debugging e2e.
---

# Verifying duckdive

The unit tests in `test/` cover the pure modules. Everything that touches DuckDB, OPFS, host
permissions or a Chrome API only shows up in the Playwright suites, which load `dist/` as an
unpacked extension.

## Running

1. `pnpm run build:e2e` — the build with the `__ddv` hooks (`src/debug.ts`) and
   `http://localhost/*` allowed. A store build publishes nothing on the page, so the suites wait
   for `window.__ddv` until they time out.
2. `node e2e/smoke.mjs` — Discover and Visualize on the demo dataset. About a minute.
3. `node e2e/cache.mjs` — host permissions, the OPFS range cache, SigV4, STS, pattern expansion,
   ALB logs and gzip handling against the local range server. About ten minutes, and it needs the
   `duckdb` CLI on PATH to write the fixture.

`SECTIONS=cache-limit,second-tab node e2e/cache.mjs` runs only the named sections (the `section(…)`
calls in the file), which turns ten minutes into one while working on a single scenario. The S3
sections expect the keys that `s3-static-keys` enters, so a full run is the reference before
calling something fixed.

Run `cache.mjs` in the background with stdout redirected to a log file: piped through `tail` it
prints nothing until it exits, which reads as a hang. `pgrep -f e2e/cache.mjs` also matches the
waiting shell's own command line and never returns — record the pid or watch the log for the
`exit=` line.

A failed step writes `fail-<step>.png` (smoke) or `fail-cache-<section>.png` (cache) to the working
directory; CI uploads them as artifacts. An exception ends only its own section.

## Traps that look like app bugs

- **Port 5299 is shared.** Two runs at once: the second range server never binds, both browsers hit
  the first one, and the `/__stats` counters and request logs mix. Check `lsof -iTCP:5299` first and
  run the suites one at a time.
- **DuckDB keeps what it has already read.** duckdb-wasm holds Parquet footers and read blocks for
  the session whatever the cache settings say. A check that expects a network request has to read
  bytes no earlier query touched: another file, or a wider time range.
- **The fixture goes stale.** `$TMPDIR/ddv-fixtures/logs.parquet` spans the seven days before it was
  generated, and `cache.mjs` regenerates it once it is a day old — otherwise the default "Last 6
  hours" finds nothing.
- **Never rebuild `dist/` while a run is going.** A `page.reload()` inside the run re-reads the
  hashed bundles and the tab loads half of two builds.
- **One app tab only.** `launchExtension` reuses the tab `onInstalled` opens; a second tab starts a
  second DuckDB and the cache hands it a read-only copy.
- **Wait with `settled(page)`**, not with a sleep: it returns when the loading bar is gone, no query
  is running and no connect is in progress, and it confirms the idle period after the 250 ms
  debounce that a range or filter change triggers.
- **The tests assert English text.** `e2e/ext-context.mjs` pins `ddv.lang` before the page loads;
  `DDV_LANG=ja pnpm run screenshots` renders another language for the store images.
