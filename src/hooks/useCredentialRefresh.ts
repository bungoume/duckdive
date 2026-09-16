// OIDC → STS credentials expire; refresh them silently before that and push them into DuckDB.

import { useEffect } from 'preact/hooks';
import { getCredentials, loadCredentials, secondsUntilExpiry, type AwsCredentials } from '../auth';
import { applyS3, type AttachedSource } from '../datasource';
import type { SourceConfig } from '../state';

const CHECK_EVERY_MS = 60_000;
const REFRESH_BEFORE_S = 600;

export function useCredentialRefresh(source: SourceConfig, attached: AttachedSource | null, onCreds: (c: AwsCredentials) => void) {
  useEffect(() => {
    if (source.kind !== 'url' || source.authMode !== 'oidc' || !attached) return;
    const timer = setInterval(async () => {
      try {
        const cur = await loadCredentials();
        if (secondsUntilExpiry(cur) > REFRESH_BEFORE_S) return;
        const c = await getCredentials(source.oidc, false);
        onCreds(c);
        await applyS3(source, c);
      } catch (e) {
        console.warn('credential refresh failed', e);
      }
    }, CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [source, attached]);
}
