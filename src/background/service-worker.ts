// The service worker: a thin, STATELESS proxy (per the architecture
// boundary rules). It never owns a translation job's lifecycle - that
// lives in reader.ts - because MV3 kills an idle service worker after
// ~30s, which would silently orphan any longer-lived state kept here
// (R1). Each message is handled independently, start to finish.
//
// Two responsibilities:
//   1. OPEN_READER_REQUEST: inject the content script into the requesting
//      tab, read back its extraction result, stash the ArticleDoc in
//      chrome.storage.session (keyed by tabId), and navigate that same tab
//      to reader.html - so the reader's own "Back" affordance can return
//      the user to the original page.
//   2. TRANSLATE_BATCH_REQUEST: read-through the on-disk cache, call the
//      active provider for misses, and return everything to the reader.
import { onTypedMessage } from '../core/messages';
import type {
  OpenReaderRequest,
  OpenReaderResponse,
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslateItemResult,
} from '../core/messages';
import type { ArticleDoc } from '../core/types';
import { clearArticleForTab, saveArticleForTab } from '../storage/article-repo';
import { getSettings, isDomainBlocked } from '../storage/settings';
import { articleCacheKey } from '../core/ids';
import { getActiveProvider } from '../translation/registry';
import { translateWithCache } from '../translation/cache';
import { TranslationError } from '../translation/provider';
import type { ExtractionFailure, ExtractionOutcome } from '../content/index';

/** Service-worker-side timeout per translate batch - independent of, and shorter than, the reader's own retry patience. */
const TRANSLATE_BATCH_TIMEOUT_MS = 25_000;

async function handleOpenReader(request: OpenReaderRequest): Promise<OpenReaderResponse> {
  const { tabId } = request;
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url;
    if (!url) {
      return { type: 'OPEN_READER_RESPONSE', ok: false, error: 'Tab has no readable URL.' };
    }

    const settings = await getSettings();
    if (isDomainBlocked(url, settings)) {
      return {
        type: 'OPEN_READER_RESPONSE',
        ok: false,
        error: 'This domain is on your privacy blocklist (Options > Blocked domains) - R10.',
      };
    }

    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__bilingualReaderExtract,
    });

    const outcome = injectionResults[0]?.result as ExtractionOutcome | ExtractionFailure | undefined;
    if (!outcome) {
      return { type: 'OPEN_READER_RESPONSE', ok: false, error: 'Content extraction produced no result.' };
    }
    if (!outcome.ok) {
      return { type: 'OPEN_READER_RESPONSE', ok: false, error: outcome.error };
    }

    const doc: ArticleDoc = outcome.doc;
    await saveArticleForTab(tabId, doc);
    await chrome.tabs.update(tabId, { url: chrome.runtime.getURL(`reader.html?tabId=${tabId}`) });
    return { type: 'OPEN_READER_RESPONSE', ok: true, articleId: doc.id };
  } catch (err) {
    return {
      type: 'OPEN_READER_RESPONSE',
      ok: false,
      error: err instanceof Error ? err.message : 'Unknown error opening the reader.',
    };
  }
}

async function handleTranslateBatch(request: TranslateBatchRequest): Promise<TranslateBatchResponse> {
  const provider = getActiveProvider();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSLATE_BATCH_TIMEOUT_MS);

  try {
    const cacheKey = articleCacheKey(request.articleUrl);
    const results = await translateWithCache(
      provider,
      cacheKey,
      request.items,
      request.from,
      request.to,
      controller.signal
    );
    const itemResults: TranslateItemResult[] = results.map((r) => ({
      id: r.id,
      ok: true,
      text: r.text,
      detectedLang: r.detectedLang,
      fromCache: r.fromCache,
    }));
    return { type: 'TRANSLATE_BATCH_RESPONSE', requestId: request.requestId, results: itemResults };
  } catch (err) {
    // The whole miss-batch failed (provider exhausted its retries, or our
    // own timeout fired) - report every requested item as failed so the
    // reader's own retry loop (R1) can re-send them later.
    const kind = err instanceof TranslationError ? err.kind : 'fatal';
    const message = err instanceof Error ? err.message : 'Unknown translation error';
    const itemResults: TranslateItemResult[] = request.items.map((item) => ({
      id: item.id,
      ok: false,
      error: { kind, message },
    }));
    return { type: 'TRANSLATE_BATCH_RESPONSE', requestId: request.requestId, results: itemResults };
  } finally {
    clearTimeout(timeout);
  }
}

onTypedMessage((request) => {
  if (request.type === 'OPEN_READER_REQUEST') return handleOpenReader(request);
  if (request.type === 'TRANSLATE_BATCH_REQUEST') return handleTranslateBatch(request);
  return undefined;
});

// Session handoff cleanup (decision #6: "dọn khi tab đóng").
chrome.tabs.onRemoved.addListener((tabId) => {
  void clearArticleForTab(tabId);
});
