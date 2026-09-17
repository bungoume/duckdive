// Local files as a data source. Files and folders picked or dropped through the File System
// Access API come with handles; kept in IndexedDB they survive a restart, so a local source can
// be remembered and reopened (Chrome then asks for read permission again). Files from a plain
// <input type="file"> or a browser without handles are used once.

import { t } from './i18n';

/** What the Data source page hands to a connect: the files to register and, when known, their handles. */
export interface LocalSelection {
  files: File[];
  handles: FileSystemHandle[];
}

export const NO_LOCAL: LocalSelection = { files: [], handles: [] };

// WICG parts of the File System Access API that lib.dom does not declare
type Permission = 'granted' | 'denied' | 'prompt';
interface PermissionHandle {
  queryPermission?(d: { mode: 'read' }): Promise<Permission>;
  requestPermission?(d: { mode: 'read' }): Promise<Permission>;
}
declare global {
  interface Window {
    showOpenFilePicker?(o?: { multiple?: boolean }): Promise<FileSystemFileHandle[]>;
    showDirectoryPicker?(): Promise<FileSystemDirectoryHandle>;
  }
  interface DataTransferItem {
    getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
  }
}

export const fsAccessAvailable = typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';

/** File names worth reading from a folder: the formats DuckDB reads, optionally compressed; hidden files are skipped. */
export function isLogFile(name: string): boolean {
  return !name.startsWith('.') && /\.(parquet|csv|tsv|json|jsonl|ndjson|log|txt|ltsv)(\.gz|\.zst)?$|\.gz$/i.test(name);
}

/** A File registered under `path` (its place below the picked folder), so equal names in different folders stay apart. */
function withPath(file: File, path: string): File {
  return path === file.name ? file : new File([file], path, { type: file.type, lastModified: file.lastModified });
}

async function walk(dir: FileSystemDirectoryHandle, prefix: string, out: File[]): Promise<void> {
  for await (const h of dir.values()) {
    if (h.kind === 'directory') await walk(h, `${prefix}${h.name}/`, out);
    else if (isLogFile(h.name)) out.push(withPath(await h.getFile(), prefix + h.name));
  }
}

/** The files behind `handles`: folders are walked, and the result is sorted by path. */
export async function filesOf(handles: FileSystemHandle[]): Promise<File[]> {
  const out: File[] = [];
  for (const h of handles) {
    if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle, `${h.name}/`, out);
    else out.push(await (h as FileSystemFileHandle).getFile());
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function selectionOf(handles: FileSystemHandle[]): Promise<LocalSelection> {
  return { files: await filesOf(handles), handles };
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** The file picker; an empty list when it was dismissed. */
export async function pickFiles(): Promise<FileSystemHandle[]> {
  try {
    return await window.showOpenFilePicker!({ multiple: true });
  } catch (e) {
    if (isAbort(e)) return [];
    throw e;
  }
}

/** The folder picker; an empty list when it was dismissed. */
export async function pickFolder(): Promise<FileSystemHandle[]> {
  try {
    return [await window.showDirectoryPicker!()];
  } catch (e) {
    if (isAbort(e)) return [];
    throw e;
  }
}

/**
 * The files and folders of a drop. Must be called during the drop event (the items are gone
 * afterwards). Handles are kept only when every item has one; otherwise the files are used once.
 */
export function dropped(dt: DataTransfer): Promise<LocalSelection> {
  const items = Array.from(dt.items)
    .filter((i) => i.kind === 'file')
    .map((i) => ({ handle: i.getAsFileSystemHandle?.() ?? null, file: i.getAsFile() }));
  return (async () => {
    const handles: FileSystemHandle[] = [];
    const files: File[] = [];
    for (const i of items) {
      const h = i.handle ? await i.handle : null;
      if (h) handles.push(h);
      else if (i.file) files.push(i.file);
    }
    if (files.length) return { files: [...files, ...(await filesOf(handles))], handles: [] };
    return selectionOf(handles);
  })();
}

/** What was picked, one entry per handle or file: "alb-logs/" for a folder, the name for a file. */
export function selectionNames(sel: LocalSelection): string[] {
  if (sel.handles.length) return sel.handles.map((h) => (h.kind === 'directory' ? `${h.name}/` : h.name));
  return sel.files.map((f) => f.name);
}

/** Source name for a selection: "alb-logs", "a.parquet" or "a.parquet +2". */
export function selectionTitle(names: string[]): string {
  if (!names.length) return '';
  const first = names[0].replace(/\/$/, '');
  return names.length === 1 ? first : `${first} +${names.length - 1}`;
}

// ---------- handles kept across restarts (IndexedDB, one entry per remembered local source) ----------

const DB = 'ddv-local';
const STORE = 'handles';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const open = indexedDB.open(DB, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE);
  const db = await request(open);
  try {
    return await request(fn(db.transaction(STORE, mode).objectStore(STORE)));
  } finally {
    db.close();
  }
}

export const storeHandles = (id: string, handles: FileSystemHandle[]) => withStore('readwrite', (s) => s.put(handles, id));
export const loadHandles = (id: string) => withStore<FileSystemHandle[] | undefined>('readonly', (s) => s.get(id));
export const forgetHandles = (id: string) => withStore('readwrite', (s) => s.delete(id));

/**
 * Reopen a remembered local source. Returns null when Chrome would have to ask for permission
 * and `interactive` is false (start-up); throws when the handles are gone or access is refused.
 */
export async function openLocal(id: string, interactive: boolean): Promise<LocalSelection | null> {
  const handles = (await loadHandles(id)) ?? [];
  if (!handles.length) throw new Error(t('src.local.forgotten'));
  for (const h of handles) {
    const p = h as FileSystemHandle & PermissionHandle;
    if (!p.queryPermission || (await p.queryPermission({ mode: 'read' })) === 'granted') continue;
    if (!interactive) return null;
    if (!p.requestPermission || (await p.requestPermission({ mode: 'read' })) !== 'granted') throw new Error(t('src.local.denied'));
  }
  return selectionOf(handles);
}
