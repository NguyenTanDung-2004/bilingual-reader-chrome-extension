// Read-through translation cache, called from the service worker's
// TRANSLATE_BATCH_REQUEST handler (R6: never re-translate what's already
// cached). Backed by storage/fs-cache.ts (File System Access, falling back
// to OPFS, falling back to an in-page Map - see that file).
//
// Important: cache entries are keyed by a hash of the sentence's *text*
// (core/ids.ts hashString), not by its ephemeral Sentence.id. A fresh
// content-script extraction assigns fresh ids every time (ids.ts's counter
// resets per call), so an id-keyed cache would never hit on a revisit -
// only a content-addressed key survives across sessions, which is the
// whole point of caching ("read the article again -> instant").
import { hashString } from '../core/ids';
import type { TranslationProvider } from './provider';
import { readArticleCache, type CachedTranslation } from '../storage/fs-cache';

export interface CacheLookupItem {
  /** Correlates back to the caller's request item - NOT used as the cache key. */
  id: string;
  text: string;
}

export interface TranslateWithCacheResult {
  id: string;
  text: string;
  detectedLang?: string;
  fromCache: boolean;
}

export function translationCacheKeyFor(text: string): string {
  return hashString(text);
}

/**
 * Looks up each item in the on-disk cache for `articleUrl`; for cache
 * misses, calls `provider.translate` (itself batched/retried/concurrency
 * capped - see google-gtx.ts) and returns the combined result in the same
 * order as `items`. Does NOT write anything back to disk - per the spec,
 * write-back is owned by the reader page's debounced-in-memory-then-flush
 * logic (see reader/reader.ts), since the service worker is stateless and
 * may be killed between messages (R1).
 */
export async function translateWithCache(
  provider: TranslationProvider,
  articleCacheKey: string,
  items: CacheLookupItem[],
  from: string,
  to: string,
  signal: AbortSignal
): Promise<TranslateWithCacheResult[]> {
  const cached = await readArticleCache(articleCacheKey);
  const cachedTranslations: Record<string, CachedTranslation> = cached?.translations ?? {};

  const results: TranslateWithCacheResult[] = new Array(items.length);
  const missPositions: number[] = [];
  const missTexts: string[] = [];

  items.forEach((item, i) => {
    const hit = cachedTranslations[translationCacheKeyFor(item.text)];
    if (hit) {
      results[i] = { id: item.id, text: hit.text, detectedLang: hit.detectedLang, fromCache: true };
    } else {
      missPositions.push(i);
      missTexts.push(item.text);
    }
  });

  if (missTexts.length > 0) {
    const translated = await provider.translate(missTexts, { from, to, signal });
    translated.forEach((t, k) => {
      const i = missPositions[k]!;
      const item = items[i]!;
      results[i] = { id: item.id, text: t.text, detectedLang: t.detectedLang, fromCache: false };
    });
  }

  return results;
}
