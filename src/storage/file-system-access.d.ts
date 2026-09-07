// Ambient patches for the parts of the File System Access API that
// TypeScript's bundled lib.dom.d.ts doesn't yet ship (as of TS 5.6):
// permission querying on a handle, and window.showDirectoryPicker(). Both
// are implemented in Chrome; see storage/fs-cache.ts for how they're used
// (with a try/catch fallback for browsers/contexts where they're absent).

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: FileSystemHandle | string;
}

interface Window {
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
