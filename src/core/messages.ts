// Typed message contract between extension contexts. Chrome's
// runtime.sendMessage/onMessage APIs are untyped by default; everything in
// this file exists so a mismatch between sender and receiver is a compile
// error instead of a silent runtime no-op.
//
// Only two message families cross a context boundary in this app:
//   1. popup -> service worker: "open the reader for this tab"
//      (inject content script, stash the ArticleDoc, navigate the tab).
//   2. reader -> service worker: "translate this batch of sentences"
//      (the service worker is a thin, stateless cache+provider proxy -
//      see translation/*). Everything else (settings, vocab, article
//      handoff) is read/written directly through src/storage/* repos from
//      whichever extension page needs it, since chrome.storage is
//      available in every extension context.

export type TranslationErrorKind = 'rate_limit' | 'auth' | 'transient' | 'fatal';

export interface OpenReaderRequest {
  type: 'OPEN_READER_REQUEST';
  tabId: number;
}

export type OpenReaderResponse =
  | { type: 'OPEN_READER_RESPONSE'; ok: true; articleId: string }
  | { type: 'OPEN_READER_RESPONSE'; ok: false; error: string };

export interface TranslateItem {
  id: string;
  text: string;
}

export interface TranslateBatchRequest {
  type: 'TRANSLATE_BATCH_REQUEST';
  requestId: string;
  /** The article's URL - used only to derive the on-disk cache file key (core/ids.ts articleCacheKey), never sent to the provider. */
  articleUrl: string;
  items: TranslateItem[];
  from: string;
  to: string;
}

export type TranslateItemResult =
  | { id: string; ok: true; text: string; detectedLang?: string; fromCache: boolean }
  | { id: string; ok: false; error: { kind: TranslationErrorKind; message: string } };

export interface TranslateBatchResponse {
  type: 'TRANSLATE_BATCH_RESPONSE';
  requestId: string;
  results: TranslateItemResult[];
}

export type ExtensionRequest = OpenReaderRequest | TranslateBatchRequest;
export type ExtensionResponse = OpenReaderResponse | TranslateBatchResponse;

/** Maps each request type to its matching response type, for sendTypedMessage's return type. */
type ResponseFor<R extends ExtensionRequest> = R extends OpenReaderRequest
  ? OpenReaderResponse
  : R extends TranslateBatchRequest
    ? TranslateBatchResponse
    : never;

/** Thin typed wrapper over chrome.runtime.sendMessage. Rejects on chrome.runtime.lastError. */
export function sendTypedMessage<R extends ExtensionRequest>(request: R): Promise<ResponseFor<R>> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: ResponseFor<R>) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Registers a typed onMessage handler. `handler` may be async; returning a
 * promise (or value) from it is enough - this wrapper takes care of
 * `sendResponse` and the `return true` needed to keep the channel open.
 */
export function onTypedMessage(
  handler: (request: ExtensionRequest, sender: chrome.runtime.MessageSender) => Promise<ExtensionResponse> | void
): void {
  chrome.runtime.onMessage.addListener((request: ExtensionRequest, sender, sendResponse) => {
    const result = handler(request, sender);
    if (result === undefined) return false;
    result.then((response) => sendResponse(response));
    return true;
  });
}
