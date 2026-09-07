// Translation cache, on disk. Per the spec this is *optional* - it must
// never block the reading flow. Three backends, tried in order, each one
// degrading gracefully to the next:
//
//   1. user-folder  - a real folder the user picked once via
//      showDirectoryPicker() (from options.html, inside a click handler),
//      whose FileSystemDirectoryHandle is persisted in IndexedDB so later
//      sessions can silently re-request permission on it.
//   2. opfs         - navigator.storage.getDirectory() (Origin Private File
//      System). No user gesture, no permission prompt, available in every
//      Chrome extension page - this is what most users transparently get
//      by default, with zero setup.
//   3. memory        - a plain in-page Map. Lost on reader reload, but the
//      reader still works.
//
// One JSON file per article (name = hash of its URL, from core/ids.ts),
// plus a shared index.json (article list + timestamps) so options.html can
// show/prune old cache entries. Callers (translation/cache.ts) own the
// debounce-then-write timing described in the spec; this module just does
// atomic single-file reads/writes.

export interface CachedTranslation {
  text: string;
  detectedLang?: string;
}

export interface CachedArticleTranslations {
  url: string;
  updatedAt: number;
  /** Keyed by sentenceId. */
  translations: Record<string, CachedTranslation>;
}

export interface CacheIndexEntry {
  key: string;
  url: string;
  updatedAt: number;
}

export type CacheBackend = 'user-folder' | 'opfs' | 'memory';

const IDB_NAME = 'bilingual-reader-fs';
const IDB_VERSION = 1; // R11: versioned IndexedDB from the first commit.
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'cacheDir';
const INDEX_FILE = 'index.json';

// --- tiny promise-based IndexedDB helpers (handle persistence only) --------

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(HANDLE_STORE)) {
        req.result.createObjectStore(HANDLE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readonly');
    const req = tx.objectStore(HANDLE_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- backend resolution ------------------------------------------------------

interface ResolvedRoot {
  handle: FileSystemDirectoryHandle;
  backend: CacheBackend;
}

/** undefined = not yet resolved this session; null = resolved to "no disk backend, use memory". */
let cachedRoot: ResolvedRoot | null | undefined;
const memoryCache = new Map<string, CachedArticleTranslations>();

async function getUserFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const handle = await idbGet<FileSystemDirectoryHandle>(HANDLE_KEY);
    if (!handle) return null;
    // Only a *silent* permission check here - requestPermission() needs a
    // user gesture in most browsers, so we never call it outside
    // chooseCacheFolder(), which is only invoked from a real click handler.
    const state = await handle.queryPermission({ mode: 'readwrite' });
    return state === 'granted' ? handle : null;
  } catch {
    return null;
  }
}

async function getOpfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

async function resolveRoot(): Promise<ResolvedRoot | null> {
  if (cachedRoot !== undefined) return cachedRoot;

  const userHandle = await getUserFolderHandle();
  if (userHandle) {
    cachedRoot = { handle: userHandle, backend: 'user-folder' };
    return cachedRoot;
  }

  const opfsHandle = await getOpfsRoot();
  if (opfsHandle) {
    cachedRoot = { handle: opfsHandle, backend: 'opfs' };
    return cachedRoot;
  }

  cachedRoot = null;
  return null;
}

/** For UI (options.html) to show which backend is actually active. */
export async function getActiveBackend(): Promise<CacheBackend> {
  const root = await resolveRoot();
  return root?.backend ?? 'memory';
}

// --- file read/write ---------------------------------------------------------

async function readJsonFile<T>(dir: FileSystemDirectoryHandle, name: string): Promise<T | null> {
  try {
    const fileHandle = await dir.getFileHandle(name);
    const file = await fileHandle.getFile();
    return JSON.parse(await file.text()) as T;
  } catch {
    return null; // missing file, corrupt JSON, or a permission hiccup - treat as a cache miss
  }
}

async function writeJsonFile(dir: FileSystemDirectoryHandle, name: string, data: unknown): Promise<void> {
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(data));
  await writable.close();
}

async function readIndex(dir: FileSystemDirectoryHandle): Promise<CacheIndexEntry[]> {
  const data = await readJsonFile<CacheIndexEntry[]>(dir, INDEX_FILE);
  return Array.isArray(data) ? data : [];
}

async function updateIndex(dir: FileSystemDirectoryHandle, entry: CacheIndexEntry): Promise<void> {
  const index = await readIndex(dir);
  const next = index.filter((e) => e.key !== entry.key);
  next.push(entry);
  await writeJsonFile(dir, INDEX_FILE, next);
}

export async function readArticleCache(cacheKey: string): Promise<CachedArticleTranslations | null> {
  const root = await resolveRoot();
  if (!root) return memoryCache.get(cacheKey) ?? null;
  return readJsonFile<CachedArticleTranslations>(root.handle, `${cacheKey}.json`);
}

export async function writeArticleCache(cacheKey: string, data: CachedArticleTranslations): Promise<void> {
  const root = await resolveRoot();
  if (!root) {
    memoryCache.set(cacheKey, data);
    return;
  }
  try {
    await writeJsonFile(root.handle, `${cacheKey}.json`, data);
    await updateIndex(root.handle, { key: cacheKey, url: data.url, updatedAt: data.updatedAt });
  } catch {
    // Disk write failed (quota, permission revoked mid-session, etc.) -
    // degrade to memory rather than lose the translation or block reading.
    memoryCache.set(cacheKey, data);
  }
}

export async function listCacheIndex(): Promise<CacheIndexEntry[]> {
  const root = await resolveRoot();
  if (!root) {
    return Array.from(memoryCache.entries()).map(([key, v]) => ({ key, url: v.url, updatedAt: v.updatedAt }));
  }
  return readIndex(root.handle);
}

export async function clearAllCache(): Promise<void> {
  memoryCache.clear();
  const root = await resolveRoot();
  if (!root) return;
  const index = await readIndex(root.handle);
  for (const entry of index) {
    try {
      await root.handle.removeEntry(`${entry.key}.json`);
    } catch {
      // already gone - fine
    }
  }
  try {
    await root.handle.removeEntry(INDEX_FILE);
  } catch {
    // nothing to remove
  }
}

// --- user-chosen folder (opt-in upgrade over OPFS) --------------------------

/** Must be called from inside a real user gesture (a click handler in options.ts) - the picker requires transient activation. */
export async function chooseCacheFolder(): Promise<boolean> {
  try {
    const picker = window.showDirectoryPicker;
    if (!picker) return false;
    const handle = await picker({ id: 'bilingual-reader-cache', mode: 'readwrite' });
    await idbSet(HANDLE_KEY, handle);
    cachedRoot = undefined; // force re-resolution (will pick up the new handle)
    return true;
  } catch {
    return false; // user cancelled the picker, or the API is unsupported in this Chrome version
  }
}

export async function forgetCacheFolder(): Promise<void> {
  await idbDelete(HANDLE_KEY);
  cachedRoot = undefined;
}

export async function hasUserFolderConfigured(): Promise<boolean> {
  return (await getUserFolderHandle()) !== null;
}
