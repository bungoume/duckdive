// Firefox's `browser` namespace is Promise-based. Chromium exposes `chrome`; some newer builds
// expose both. Prefer `browser` when it exists so every awaited API call has the same semantics.
type WebExtensionGlobals = typeof globalThis & { browser?: typeof chrome; chrome?: typeof chrome };

const globals = globalThis as WebExtensionGlobals;
export const webext = (globals.browser ?? globals.chrome) as typeof chrome;
