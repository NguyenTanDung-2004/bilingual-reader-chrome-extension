// Id and cache-key generation. Kept dependency-free (no crypto.subtle) so it
// works identically in content scripts, service worker, and reader pages,
// and so tests don't need an async hash.

let counter = 0;

/** Monotonic-ish id for a block/sentence within one extraction pass. Not globally unique across pages. */
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}${counter.toString(36)}`;
}

export function makeBlockId(): string {
  return nextId('b');
}

export function makeSentenceId(): string {
  return nextId('s');
}

/** Resets the counter. Tests call this so ids are deterministic per test file. */
export function resetIdCounter(): void {
  counter = 0;
}

/**
 * Deterministic non-cryptographic hash (FNV-1a, 32-bit) rendered as 8 hex
 * chars. Used for cache filenames keyed by URL - collisions are acceptable
 * (worst case: a stale cache read/overwrite), cryptographic strength is not
 * needed.
 */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Cache key / filename stem for an article, derived from its URL (query/hash stripped for stability). */
export function articleCacheKey(url: string): string {
  let normalized = url;
  try {
    const u = new URL(url);
    normalized = `${u.origin}${u.pathname}`;
  } catch {
    // Not a parseable URL (shouldn't happen for tab URLs) - hash the raw string.
  }
  return hashString(normalized);
}
