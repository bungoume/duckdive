// OPFS synchronous access handles are typed in lib.webworker only; the worker sources are
// compiled against lib.dom like the rest of the app, so the two interfaces are declared here.
// A .d.ts without imports is a global script: these merge into the DOM declarations.

interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}
