export interface CacheStats {
  requests: number;
  passthrough: number;
  chunkHits: number;
  chunkMisses: number;
  bytesFromCache: number;
  bytesFromNetwork: number;
  bytesDownloaded: number;
  headsSynthesized: number;
  headsNetwork: number;
  corruptions: number;
  /** files dropped to stay within the size limit (this session) */
  evictions: number;
  files: Record<string, { hits: number; misses: number; bytesFromCache: number; bytesFromNetwork: number; bytesDownloaded: number }>;
  log: CacheLogEntry[];
}

/** One request as seen by the worker (see LogEntry in the worker). */
export interface CacheLogEntry {
  t: number;
  method: string;
  url: string;
  range: string | null;
  outcome: string;
  status?: number;
  bytes?: number;
  enc?: string;
  head?: string;
}

export interface CacheConfig {
  enabled: boolean;
  chunkSize: number;
  /** cached data allowed on disk; 0 = no limit. Beyond it whole files are dropped, least recently used first */
  maxBytes: number;
}

export interface CachedFile {
  url: string;
  size: number;
  etag: string;
  cachedChunks: number;
  cachedBytes: number;
  chunkSize: number;
}

export interface SeedFile {
  url: string;
  size: number;
  etag: string;
  lastModified?: string;
  /** bucket / key when the object came from an S3 listing (lets the page fetch it signed) */
  s3?: { bucket: string; key: string };
}

export interface CacheSummary {
  /** files with known metadata (seeded from listings or HEADs) */
  known: number;
  cachedFiles: number;
  cachedBytes: number;
  slabSize: number;
  wasted: number;
}

export interface CacheRequests {
  ping: Record<never, never>;
  stats: Record<never, never>;
  seed: { files: SeedFile[] };
  cached: { urls: string[] };
  files: { limit?: number; all?: boolean };
  compact: Record<never, never>;
  clear: Record<never, never>;
  purge: { url: string };
  config: { config: Partial<CacheConfig> };
}
export interface CacheResponses {
  ping: { opfsError: string | null; readOnly: boolean };
  stats: { stats: CacheStats; config: CacheConfig; opfsError: string | null; readOnly: boolean };
  seed: { seeded: number };
  cached: { cached: string[] };
  files: { files: CachedFile[]; summary: CacheSummary };
  compact: { slabSize: number; wasted: number };
  clear: { cleared: true };
  purge: { removed: number };
  config: { config: CacheConfig };
}
export type CacheRequest = { [K in keyof CacheRequests]: { id: string; type: K } & CacheRequests[K] }[keyof CacheRequests];
export type CacheReply = { ok: false; error: string } | { [K in keyof CacheResponses]: { ok: true } & CacheResponses[K] }[keyof CacheResponses];
