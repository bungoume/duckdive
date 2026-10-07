import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/**', 'release/**', 'public/**', 'node_modules/**', '.claude/**', '**/*.d.ts'] },
  { linterOptions: { reportUnusedDisableDirectives: 'error', reportUnusedInlineConfigs: 'error' } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'test/**/*.ts', 'build/**/*.ts', 'vitest.config.ts', 'vite.config.ts'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' }, parserOptions: { projectService: true } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      // the chart code drives Observable Plot's untyped scale objects
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      // a promise nobody awaits or catches becomes an unhandled rejection
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['e2e/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
