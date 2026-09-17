// Query-time download guard: before the pages query a new file set, estimate what is not
// cached yet and hold the queries when more files than the threshold would be downloaded,
// until the user runs them anyway.

import { useEffect, useState } from 'preact/hooks';
import type { AttachedSource } from '../datasource';
import { estimatePendingDownload, type DownloadEstimate } from '../download';
import type { SourceConfig } from '../sources';

export interface Gate {
  status: 'checking' | 'blocked' | 'ok';
  estimate?: DownloadEstimate;
}

/** `acked` holds the file set (joined) the user already accepted; it is never questioned again. */
export function useDownloadGate(source: SourceConfig, attached: AttachedSource | null, acked: { current: string }) {
  /** which file set the estimate belongs to, and what it found (null = nothing to warn about) */
  const [checked, setChecked] = useState<{ files: string; estimate: DownloadEstimate | null }>({ files: '', estimate: null });
  // only these parts of the source feed the estimate; a renamed source or a new time field must not re-run it
  const cfgKey = JSON.stringify([source.kind, source.maxFiles, source.s3.endpoint, source.s3.region, source.s3.urlStyle]);
  const files = attached && source.kind === 'url' ? attached.files.join('\n') : '';
  const settled = !files || acked.current === files || checked.files === files;

  useEffect(() => {
    if (!attached || source.kind !== 'url' || !files || acked.current === files) return;
    let live = true;
    estimatePendingDownload(source, attached)
      .then((estimate) => live && setChecked({ files, estimate }))
      .catch(() => live && setChecked({ files, estimate: null }));
    return () => {
      live = false;
    };
    // `source` is compared through cfgKey (see above)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, cfgKey]);

  // Decided while rendering, not in an effect: the render that brings a new file set already says
  // "checking", so the pages hold instead of starting a query this gate may be about to stop and
  // then starting it a second time once the estimate arrives.
  const gate: Gate = !settled ? { status: 'checking' } : checked.files === files && checked.estimate ? { status: 'blocked', estimate: checked.estimate } : { status: 'ok' };

  const runAnyway = () => {
    acked.current = files;
    setChecked({ files, estimate: null });
  };
  return { gate, runAnyway };
}
