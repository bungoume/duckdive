import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isLogFile,
  loadHandles,
  selectionNames,
  selectionTitle,
  uniqueLocalNames,
  type LocalSelection,
} from '../src/localfiles';
import { DEFAULT_SOURCE, sourceKey } from '../src/sources';

const handle = (kind: 'file' | 'directory', name: string) => ({ kind, name }) as FileSystemHandle;

describe('persisted file handles', () => {
  afterEach(() => vi.unstubAllGlobals());

  function storedHandles(value: unknown) {
    const request = (result: unknown) => {
      const r = { result, onsuccess: null as (() => void) | null };
      queueMicrotask(() => r.onsuccess?.());
      return r;
    };
    const close = vi.fn();
    vi.stubGlobal('indexedDB', {
      open: () =>
        request({
          transaction: () => ({ objectStore: () => ({ get: () => request(value) }) }),
          close,
        }),
    });
    return close;
  }

  it('returns file and directory handles restored by the browser', async () => {
    class Handle {
      constructor(readonly kind: string) {}
    }
    vi.stubGlobal('FileSystemHandle', Handle);
    const handles = [new Handle('file'), new Handle('directory')];
    const close = storedHandles(handles);
    expect(await loadHandles('picked-files')).toEqual(handles);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, {}, [{ kind: 'file', name: 'forged' }]].map((raw) => ({ raw })))(
    'ignores missing or invalid handles (case %#)',
    async ({ raw }) => {
      vi.stubGlobal('FileSystemHandle', class {});
      const close = storedHandles(raw);
      expect(await loadHandles('picked-files')).toBeUndefined();
      expect(close).toHaveBeenCalledOnce();
    },
  );
});

describe('local registration names', () => {
  it('preserves unique paths and avoids collisions with names already in the selection', () => {
    const files = [
      'same.csv.gz',
      'same.csv.gz',
      'same (2).csv.gz',
      'dir/same.csv',
      'dir/same.csv',
      'plain',
      'plain',
    ].map((name) => ({ name }));
    expect(uniqueLocalNames(files)).toEqual([
      'same.csv.gz',
      'same (3).csv.gz',
      'same (2).csv.gz',
      'dir/same.csv',
      'dir/same (2).csv',
      'plain',
      'plain (2)',
    ]);
  });
});

describe('isLogFile', () => {
  it('accepts the readable formats, compressed or not, and skips hidden files', () => {
    for (const n of ['a.parquet', 'b.csv.gz', 'c.jsonl', 'd.log.zst', 'e.ltsv', 'x.gz'])
      expect(isLogFile(n)).toBe(true);
    for (const n of ['.DS_Store', 'notes.md', 'image.png', 'archive.zip']) expect(isLogFile(n)).toBe(false);
  });
});

describe('selection names', () => {
  it('lists handles (folders with a slash) or, without handles, the files', () => {
    const sel: LocalSelection = { files: [], handles: [handle('directory', 'alb'), handle('file', 'a.parquet')] };
    expect(selectionNames(sel)).toEqual(['alb/', 'a.parquet']);
    expect(selectionNames({ files: [new File([], 'x.csv')], handles: [] })).toEqual(['x.csv']);
  });

  it('names the source after the first pick', () => {
    expect(selectionTitle([])).toBe('');
    expect(selectionTitle(['alb/'])).toBe('alb');
    expect(selectionTitle(['a.parquet', 'b.parquet', 'c.parquet'])).toBe('a.parquet +2');
  });
});

describe('sourceKey for local sources', () => {
  it('is the stored handle id, and null for a one-off pick', () => {
    expect(sourceKey({ ...DEFAULT_SOURCE, kind: 'local', localId: 'abc' })).toBe('["local","abc"]');
    expect(sourceKey({ ...DEFAULT_SOURCE, kind: 'local' })).toBeNull();
  });
});
