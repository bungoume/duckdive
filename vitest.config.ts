import { defineConfig } from 'vitest/config';

// Unit tests for the pure modules (query parser, date math, tick placement, pattern
// expansion, gzip member walking, SQL building, URL state). They run in Node with a few
// browser globals stubbed in test/setup.ts; everything that needs DuckDB or Chrome is
// covered by the Playwright suites in e2e/.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    coverage: { include: ['src/**'], reporter: ['text-summary', 'html'] },
  },
});
