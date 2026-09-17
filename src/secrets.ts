// Static S3 secrets (secret access key, session token) never touch disk: they live in
// chrome.storage.session (memory only, cleared when the browser closes; sessionStorage outside
// the extension), keyed by the source's identity plus the access key ID. localStorage keeps the
// rest of the configuration, access key ID included, so after a restart the form shows which key
// was in use and asks for its secret again.

import { readSession, writeSession } from './sessionStore';
import { sourceKey, type SourceConfig } from './state';

const SESSION_KEY = 'ddv.s3secrets';

interface Secret {
  secretAccessKey: string;
  sessionToken: string;
}

type Store = Record<string, Secret>;

const readAll = async (): Promise<Store> => (await readSession<Store>(SESSION_KEY)) ?? {};
const writeAll = (store: Store): Promise<void> => writeSession(SESSION_KEY, store);

function secretKey(cfg: SourceConfig): string | null {
  const key = sourceKey(cfg);
  return key && cfg.authMode === 'static' && cfg.s3.accessKeyId ? `${key}|${cfg.s3.accessKeyId}` : null;
}

/** Keep the secrets of `cfg` for this browser session. */
export async function storeSecrets(cfg: SourceConfig): Promise<void> {
  const key = secretKey(cfg);
  if (!key || !cfg.s3.secretAccessKey) return;
  const store = await readAll();
  store[key] = { secretAccessKey: cfg.s3.secretAccessKey, sessionToken: cfg.s3.sessionToken };
  await writeAll(store);
}

/** `cfg` with the session's secrets filled in when it has none of its own. */
export async function withSecrets(cfg: SourceConfig): Promise<SourceConfig> {
  const key = secretKey(cfg);
  if (!key || cfg.s3.secretAccessKey) return cfg;
  const s = (await readAll())[key];
  return s ? { ...cfg, s3: { ...cfg.s3, secretAccessKey: s.secretAccessKey, sessionToken: s.sessionToken } } : cfg;
}

/** Drop every secret kept for the source identity `key` (see sourceKey). */
export async function forgetSecrets(key: string): Promise<void> {
  const store = await readAll();
  let changed = false;
  for (const k of Object.keys(store)) {
    if (k.startsWith(key + '|')) {
      delete store[k];
      changed = true;
    }
  }
  if (changed) await writeAll(store);
}
