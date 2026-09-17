// Query-time guard: how much the next query would have to download.
//
// A query opens every file behind the source view (Parquet: footer + needed row groups, text /
// gzip: the whole file). Everything goes through the OPFS range cache, so a file with at least one
// cached chunk has been downloaded before and is not counted. When more files than the source's
// warning threshold are still untouched, the pages hold their queries until the user confirms,
// showing the count and (as an upper bound) the sizes the listing reported.

import { cacheCached } from './cache';
import { s3HttpsUrl, type AttachedSource } from './datasource';
import { DEFAULT_MAX_FILES } from './s3list';
import type { SourceConfig } from './sources';

export interface DownloadEstimate {
  /** files the cache has nothing for */
  files: number;
  /** their total size where the listing reported one */
  bytes: number;
  /** files whose size is unknown (plain https URLs) */
  unknownSizes: number;
  threshold: number;
}

/** Estimate for the files of `a`, or null when the count stays within the threshold. */
export async function estimatePendingDownload(cfg: SourceConfig, a: AttachedSource): Promise<DownloadEstimate | null> {
  if (cfg.kind !== 'url') return null;
  const threshold = cfg.maxFiles || DEFAULT_MAX_FILES;
  if (a.files.length <= threshold) return null;
  // the worker matches on its own cache key (signed-URL parameters stripped), so ask it
  const https = a.files.map((u) => (u.startsWith('s3://') ? s3HttpsUrl(u, cfg.s3) : u));
  let cached = new Set<string>();
  try {
    cached = new Set((await cacheCached(https.filter((u): u is string => !!u))).cached);
  } catch {
    /* cache worker unavailable: every file counts as not downloaded */
  }
  let files = 0;
  let bytes = 0;
  let unknownSizes = 0;
  https.forEach((u, i) => {
    if (u && cached.has(u)) return;
    files++;
    const size = a.fileSizes[i];
    if (size === null || size === undefined) unknownSizes++;
    else bytes += size;
  });
  if (files <= threshold) return null;
  return { files, bytes, unknownSizes, threshold };
}
