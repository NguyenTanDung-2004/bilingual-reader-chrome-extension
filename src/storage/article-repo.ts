// ArticleDoc handoff between the content-script extraction step and the
// reader page. Uses chrome.storage.session (RAM-only, cleared by Chrome on
// browser restart) keyed by tabId, per the spec: the reader is opened by
// navigating that *same* tab to reader.html?tabId=<N>, so the tabId is a
// natural, already-unique handoff key, and background/service-worker.ts
// clears the entry via chrome.tabs.onRemoved so it never lingers.
import type { ArticleDoc } from '../core/types';

function sessionKey(tabId: number): string {
  return `article:${tabId}`;
}

export async function saveArticleForTab(tabId: number, doc: ArticleDoc): Promise<void> {
  await chrome.storage.session.set({ [sessionKey(tabId)]: doc });
}

export async function getArticleForTab(tabId: number): Promise<ArticleDoc | undefined> {
  const stored = await chrome.storage.session.get(sessionKey(tabId));
  return stored[sessionKey(tabId)] as ArticleDoc | undefined;
}

export async function clearArticleForTab(tabId: number): Promise<void> {
  await chrome.storage.session.remove(sessionKey(tabId));
}
