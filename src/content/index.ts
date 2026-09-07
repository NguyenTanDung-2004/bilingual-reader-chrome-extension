// Entry point injected on demand via chrome.scripting.executeScript (see
// background/service-worker.ts's OPEN_READER_REQUEST handler) - never
// declared as a manifest content_script, so it only ever runs when the
// user explicitly asks to open the reader for the current tab.
//
// Chrome's executeScript "return the completion value of the file" story
// is unreliable once the file is bundled into an IIFE by esbuild (the
// wrapper's own call expression, not our code, becomes the last
// statement). So instead we stash the result on `window` and let the
// service worker read it back with a second, tiny executeScript({func})
// call, which Chrome *does* reliably return the value of.
import { extractArticle } from './extract';
import type { ArticleDoc } from '../core/types';

export interface ExtractionOutcome {
  ok: true;
  doc: ArticleDoc;
}

export interface ExtractionFailure {
  ok: false;
  error: string;
}

declare global {
  interface Window {
    __bilingualReaderExtract?: ExtractionOutcome | ExtractionFailure;
  }
}

try {
  const id = crypto.randomUUID();
  const doc = extractArticle(document, location.href, id);
  window.__bilingualReaderExtract = { ok: true, doc };
} catch (err) {
  window.__bilingualReaderExtract = { ok: false, error: err instanceof Error ? err.message : String(err) };
}
