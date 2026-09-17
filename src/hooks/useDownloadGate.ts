// Query-time download guard: before the pages query a new file set, estimate what is not
// cached yet and hold the queries when more files than the threshold would be downloaded,
// until the user runs them anyway.

import { useEffect, useState } from 'preact/hooks';
import type { AttachedSource } from '../datasource';
import { estimatePendingDownload, type DownloadEstimate } from '../download';
import type { SourceConfig } from '../state';

export interface Gate {
  status: 'checking' | 'blocked' | 'ok';
  estimate?: DownloadEstimate;
}

/** `acked` holds the file set (joined) the user already accepted; it is never questioned again. */
export function useDownloadGate(source: SourceConfig, attached: AttachedSource | null, acked: { current: string }) {
  const [gate, setGate] = useState<Gate>({ status: 'ok' });
  // only these parts of the source feed the estimate; a renamed source or a new time field must not re-run it
  const cfgKey = JSON.stringify([source.kind, source.maxFiles, source.s3.endpoint, source.s3.region, source.s3.urlStyle]);
  useEffect(() => {
    if (!attached || source.kind !== 'url') {
      setGate({ status: 'ok' });
      return;
    }
    const key = attached.files.join('\n');
    if (acked.current === key) {
      setGate({ status: 'ok' });
      return;
    }
    let live = true;
    setGate({ status: 'checking' });
    estimatePendingDownload(source, attached)
      .then((estimate) => live && setGate(estimate ? { status: 'blocked', estimate } : { status: 'ok' }))
      .catch(() => live && setGate({ status: 'ok' }));
    return () => {
      live = false;
    };
  }, [attached, cfgKey]);
  const runAnyway = () => {
    acked.current = attached?.files.join('\n') ?? '';
    setGate({ status: 'ok' });
  };
  return { gate, runAnyway };
}
