// OIDC → STS credentials expire; refresh them silently before that and push them into DuckDB.
// A refresh that fails (the identity provider's session ended, the network is down) is reported
// so the page can say why queries are about to fail instead of showing bare 403s.

import { useEffect, useState } from 'preact/hooks';
import { getCredentials, loadCredentials, secondsUntilExpiry, type AwsCredentials } from '../auth';
import { applyS3, type AttachedSource } from '../datasource';
import { describeError } from '../errors';
import type { SourceConfig } from '../sources';

const CHECK_EVERY_MS = 60_000;
/** Refresh once less than this remains; the README promises ten minutes. */
const REFRESH_BEFORE_S = 600;

export function useCredentialRefresh(source: SourceConfig, attached: AttachedSource | null, onCreds: (c: AwsCredentials) => void): { refreshError: string | null } {
  const [refreshError, setRefreshError] = useState<string | null>(null);
  useEffect(() => {
    setRefreshError(null);
    if (source.kind !== 'url' || source.authMode !== 'oidc' || !attached) return;
    const timer = setInterval(async () => {
      try {
        const cur = await loadCredentials(source.oidc);
        // Empty means the user signed out. A bad/expired entry is non-null and should refresh.
        if (!cur) return;
        if (secondsUntilExpiry(cur) > REFRESH_BEFORE_S) return;
        const c = await getCredentials(source.oidc, false, REFRESH_BEFORE_S);
        onCreds(c);
        await applyS3(source, c);
        setRefreshError(null);
      } catch (e) {
        console.warn('credential refresh failed', e);
        setRefreshError(describeError(e));
      }
    }, CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [source, attached, onCreds]);
  return { refreshError };
}
