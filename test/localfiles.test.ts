import { describe, expect, it } from 'vitest';
import { isLogFile, selectionNames, selectionTitle, type LocalSelection } from '../src/localfiles';
import { DEFAULT_SOURCE, sourceKey } from '../src/sources';

const handle = (kind: 'file' | 'directory', name: string) => ({ kind, name }) as FileSystemHandle;

describe('isLogFile', () => {
  it('accepts the readable formats, compressed or not, and skips hidden files', () => {
    for (const n of ['a.parquet', 'b.csv.gz', 'c.jsonl', 'd.log.zst', 'e.ltsv', 'x.gz']) expect(isLogFile(n)).toBe(true);
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
