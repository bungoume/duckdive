// Hooks for the e2e tests and for debugging from the DevTools console, published on
// `window.__ddv`. They exist only in dev builds and in builds made with VITE_DDV_DEBUG=1
// (`pnpm run build:e2e`); a store build publishes nothing on the page.

export const DEBUG = import.meta.env.DEV || import.meta.env.VITE_DDV_DEBUG === '1';

declare global {
  interface Window {
    __ddv?: Record<string, unknown>;
  }
}

export function expose(fns: Record<string, unknown>): void {
  if (!DEBUG || typeof window === 'undefined') return;
  window.__ddv = { ...(window.__ddv ?? {}), ...fns };
}
