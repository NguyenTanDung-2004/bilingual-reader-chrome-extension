// Generic, provider-agnostic batching primitives: chunk a list of texts to
// fit request-size limits, run a set of tasks under a concurrency cap, and
// retry-with-backoff on a caller-defined "is this retryable" predicate.
//
// This module knows nothing about Google Translate, HTTP, or chrome.* APIs.
// It is used from two very different places for two different purposes:
//   - reader.ts (orchestrator) uses it to slice a whole article's sentences
//     into TRANSLATE_BATCH-sized messages, cap how many are in flight to the
//     service worker at once, and back off when a message comes back
//     rate_limit-flagged.
//   - translation/cache.ts (inside the service worker) uses the exact same
//     primitives, but keyed to the *real* active TranslationProvider's
//     limits, to further split a cache-miss batch into requests the
//     provider can actually accept, and to retry a single provider call.

export interface BatchLimits {
  maxItemsPerRequest: number;
  maxCharsPerRequest: number;
}

export interface BatchableItem {
  text: string;
}

/**
 * Groups items into ordered chunks that each respect both the item-count
 * and total-character limits. Item order is preserved across chunks. A
 * single item whose own text already exceeds maxCharsPerRequest still gets
 * placed alone in its own (oversized) chunk rather than being dropped -
 * the caller/provider decides how to fail or truncate that case.
 */
export function chunkByLimits<T extends BatchableItem>(items: readonly T[], limits: BatchLimits): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;

  for (const item of items) {
    const itemChars = item.text.length;
    const wouldExceedCount = current.length >= limits.maxItemsPerRequest;
    const wouldExceedChars = current.length > 0 && currentChars + itemChars > limits.maxCharsPerRequest;
    if (wouldExceedCount || wouldExceedChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += itemChars;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Runs `task` over `items` with at most `concurrency` in flight at once. Results preserve input order. */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      results[i] = await task(items[i] as T, i);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export interface BackoffOptions {
  /** Total attempts including the first (non-retry) one. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (error: unknown) => boolean;
  /** Overridable for tests; defaults to real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Overridable for tests; defaults to Math.random. */
  random?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `fn` with exponential backoff + jitter (half fixed delay, half
 * random, capped at maxDelayMs) whenever it rejects with a
 * `opts.isRetryable` error, up to `maxAttempts` total tries. Rethrows the
 * last error once attempts are exhausted, or immediately for a
 * non-retryable error.
 */
export async function withBackoff<T>(fn: (attempt: number) => Promise<T>, opts: BackoffOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= opts.maxAttempts || !opts.isRetryable(err)) throw err;
      const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
      const delay = exp * 0.5 + random() * exp * 0.5;
      await sleep(delay);
    }
  }
  // Unreachable (loop always returns or throws), but keeps TS happy.
  throw lastError;
}

/** Reader-side default for slicing an article into TRANSLATE_BATCH messages. Deliberately conservative and provider-independent - the service worker re-chunks to the active provider's real limits before calling it. */
export const DEFAULT_MESSAGE_BATCH_LIMITS: BatchLimits = {
  maxItemsPerRequest: 40,
  maxCharsPerRequest: 4000,
};

/** Reader-side default for how many TRANSLATE_BATCH messages may be in flight at once (R6). */
export const DEFAULT_CONCURRENCY = 3;
