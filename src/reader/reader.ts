// The reader page: this is the orchestrator (per the architecture rules)
// that owns the whole translation job's lifecycle - viewport-first
// priority, concurrency-capped batches sent to the service worker,
// retry/backoff bookkeeping at the batch level, progress UI, and the
// debounced-then-pagehide disk cache write-back. The service worker never
// holds any of this state (R1: it can be killed between messages).
import { renderArticle, fillTranslation, markTranslationError } from './render';
import { wireHighlightSync, wireSelectionSave } from './interactions';
import { getArticleForTab } from '../storage/article-repo';
import { getSettings } from '../storage/settings';
import { readArticleCache, writeArticleCache } from '../storage/fs-cache';
import { addVocabEntry, buildVocabEntry } from '../storage/vocab-repo';
import { articleCacheKey, hashString } from '../core/ids';
import { sendTypedMessage } from '../core/messages';
import { chunkByLimits, runWithConcurrency, DEFAULT_MESSAGE_BATCH_LIMITS, DEFAULT_CONCURRENCY } from '../core/batching';
import { isTextBlock, type ArticleDoc, type Sentence } from '../core/types';
import type { RenderedSentenceRefs } from './render';

/** R8: long-article gate. Above this many pending sentences, translate the first N and offer a "translate more" button. */
const MAX_AUTO_TRANSLATE_SENTENCES = 800;
/** R1/orchestrator: stop and surface a manual "Thử lại" affordance after this many consecutive failed batches. */
const MAX_CONSECUTIVE_BATCH_FAILURES = 3;
const CACHE_FLUSH_DEBOUNCE_MS = 2000;

interface BannerAction {
  label: string;
  onClick: () => void;
}

function showBanner(bannersEl: HTMLElement, kind: 'warn' | 'error', message: string, actions: BannerAction[]): HTMLElement {
  const el = document.createElement('div');
  el.className = `br-banner br-banner--${kind}`;
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    el.appendChild(btn);
  }
  bannersEl.appendChild(el);
  return el;
}

function updateProgress(bar: HTMLElement, label: HTMLElement, done: number, total: number): void {
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  bar.style.width = `${pct}%`;
  label.textContent = done >= total ? 'Da dich xong' : `Dang dich ${done}/${total} cau`;
}

function collectAllSentences(doc: ArticleDoc): Sentence[] {
  const out: Sentence[] = [];
  for (const block of doc.blocks) {
    if (block.kind === 'img') {
      if (block.caption) out.push(...block.caption);
      continue;
    }
    if (!isTextBlock(block)) continue;
    out.push(...block.sentences);
  }
  return out;
}

async function translateSingle(articleUrl: string, targetLang: string, text: string): Promise<string> {
  const response = await sendTypedMessage({
    type: 'TRANSLATE_BATCH_REQUEST',
    requestId: crypto.randomUUID(),
    articleUrl,
    items: [{ id: 'adhoc', text }],
    from: 'auto',
    to: targetLang,
  });
  const result = response.results[0];
  if (result?.ok) return result.text;
  throw new Error(result && !result.ok ? result.error.message : 'Khong dich duoc cum tu nay.');
}

interface OrchestratorArgs {
  doc: ArticleDoc;
  pending: Sentence[];
  sentenceRefs: Map<string, RenderedSentenceRefs>;
  cacheKey: string;
  targetLang: string;
  inMemoryTranslations: Map<string, { text: string; detectedLang?: string }>;
  progressBar: HTMLElement;
  progressLabel: HTMLElement;
  bannersEl: HTMLElement;
  rootEl: HTMLElement;
  totalSentenceCount: number;
}

async function runTranslationOrchestrator(args: OrchestratorArgs): Promise<void> {
  const {
    doc,
    pending,
    sentenceRefs,
    cacheKey,
    targetLang,
    inMemoryTranslations,
    progressBar,
    progressLabel,
    bannersEl,
    rootEl,
    totalSentenceCount,
  } = args;

  if (pending.length === 0) {
    updateProgress(progressBar, progressLabel, totalSentenceCount, totalSentenceCount);
    return;
  }

  // Derived, not threaded through recursive calls: how many of ALL the
  // article's sentences are already done is exactly total minus however
  // many are in `pending` right now - correct both on first entry and on
  // the "Dich tiep" (R8 long-article gate) recursive re-entry, where a
  // stale passed-through counter would have under-reported progress.
  const alreadyDoneCount = totalSentenceCount - pending.length;

  let toTranslateNow = pending;
  if (pending.length > MAX_AUTO_TRANSLATE_SENTENCES) {
    toTranslateNow = pending.slice(0, MAX_AUTO_TRANSLATE_SENTENCES);
    const remaining = pending.slice(MAX_AUTO_TRANSLATE_SENTENCES);
    const gate = document.createElement('div');
    gate.className = 'br-continue-gate';
    const btn = document.createElement('button');
    btn.textContent = `Bai rat dai (con ${remaining.length} cau) - Dich tiep`;
    btn.addEventListener('click', () => {
      gate.remove();
      void runTranslationOrchestrator({ ...args, pending: remaining });
    });
    gate.appendChild(btn);
    rootEl.appendChild(gate);
  }

  let doneCount = alreadyDoneCount;
  updateProgress(progressBar, progressLabel, doneCount, totalSentenceCount);

  // Viewport-first priority: observe each pending sentence's original-column
  // node and let one frame of IntersectionObserver reports reorder the queue.
  const visible = new Set<string>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const sid = (entry.target as HTMLElement).dataset.sid;
        if (sid && entry.isIntersecting) visible.add(sid);
      }
    },
    { rootMargin: '400px 0px' }
  );
  for (const s of toTranslateNow) {
    const el = sentenceRefs.get(s.id)?.origEl;
    if (el) observer.observe(el);
  }
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  observer.disconnect();

  const ordered = [
    ...toTranslateNow.filter((s) => visible.has(s.id)),
    ...toTranslateNow.filter((s) => !visible.has(s.id)),
  ];

  let flushTimer: number | undefined;
  const flushCacheToDisk = (): void => {
    void writeArticleCache(cacheKey, {
      url: doc.url,
      updatedAt: Date.now(),
      translations: Object.fromEntries(inMemoryTranslations),
    });
  };
  const scheduleFlush = (): void => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = window.setTimeout(flushCacheToDisk, CACHE_FLUSH_DEBOUNCE_MS);
  };
  const onPageHide = (): void => flushCacheToDisk(); // safety net - not depended on (decision #8)
  window.addEventListener('pagehide', onPageHide);

  let consecutiveFailures = 0;
  let stopped = false;

  async function processBatch(batch: Sentence[]): Promise<void> {
    if (stopped || batch.length === 0) return;

    const response = await sendTypedMessage({
      type: 'TRANSLATE_BATCH_REQUEST',
      requestId: crypto.randomUUID(),
      articleUrl: doc.url,
      items: batch.map((s) => ({ id: s.id, text: s.text })),
      from: 'auto',
      to: targetLang,
    }).catch((err: unknown) => ({
      type: 'TRANSLATE_BATCH_RESPONSE' as const,
      requestId: '',
      // The service worker may have been killed mid-flight (R1) - surface
      // every item in this batch as failed so the same retry path below
      // handles it uniformly, rather than throwing out of processBatch.
      results: batch.map((s) => ({
        id: s.id,
        ok: false as const,
        error: { kind: 'transient' as const, message: err instanceof Error ? err.message : String(err) },
      })),
    }));

    let anyFailed = false;
    for (const result of response.results) {
      if (result.ok) {
        const refs = sentenceRefs.get(result.id);
        if (refs) fillTranslation(refs.transEl, result.text);
        const sentence = batch.find((s) => s.id === result.id);
        if (sentence) {
          inMemoryTranslations.set(hashString(sentence.text), {
            text: result.text,
            detectedLang: result.detectedLang,
          });
        }
        doneCount += 1;
      } else {
        anyFailed = true;
        const refs = sentenceRefs.get(result.id);
        if (refs) markTranslationError(refs.transEl);
      }
    }
    updateProgress(progressBar, progressLabel, doneCount, totalSentenceCount);
    scheduleFlush();

    if (anyFailed) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
        stopped = true;
        showBanner(
          bannersEl,
          'error',
          'Dich bi loi lien tuc (mat mang hoac bi gioi han toc do). Da dung lai de tranh lam viec vo ich.',
          [
            {
              label: 'Thu lai',
              onClick: () => {
                document.querySelectorAll('.br-banner--error').forEach((el) => el.remove());
                consecutiveFailures = 0;
                stopped = false;
                const stillPending = ordered.filter((s) => !inMemoryTranslations.has(hashString(s.text)));
                void runWithConcurrency(chunkByLimits(stillPending, DEFAULT_MESSAGE_BATCH_LIMITS), DEFAULT_CONCURRENCY, processBatch);
              },
            },
          ]
        );
      }
    } else {
      consecutiveFailures = 0;
    }
  }

  const batches = chunkByLimits(ordered, DEFAULT_MESSAGE_BATCH_LIMITS);
  await runWithConcurrency(batches, DEFAULT_CONCURRENCY, processBatch);

  window.removeEventListener('pagehide', onPageHide);
  flushCacheToDisk();
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const tabId = Number(params.get('tabId'));

  const bannersEl = document.getElementById('br-banners');
  const rootEl = document.getElementById('br-root');
  const titleEl = document.getElementById('br-title');
  const backBtn = document.getElementById('br-back-btn');
  const progressBar = document.getElementById('br-progress-bar');
  const progressLabel = document.getElementById('br-progress-label');
  if (!bannersEl || !rootEl || !titleEl || !backBtn || !progressBar || !progressLabel) {
    throw new Error('reader.html is missing an expected element - build/markup out of sync.');
  }

  backBtn.addEventListener('click', () => history.back());

  if (!Number.isFinite(tabId)) {
    showBanner(bannersEl, 'error', 'Thieu thong tin tab. Hay bam icon extension de mo lai.', []);
    return;
  }

  const doc = await getArticleForTab(tabId);
  if (!doc) {
    showBanner(bannersEl, 'error', 'Khong tim thay noi dung da trich xuat cho tab nay. Hay bam icon extension de mo lai.', []);
    return;
  }

  const settings = await getSettings();
  document.documentElement.style.setProperty('--br-font-size', `${settings.fontSizePx}px`);
  titleEl.textContent = doc.title;
  document.title = `${doc.title} - Bilingual Reader`;

  if (doc.usedFallbackExtraction) {
    showBanner(
      bannersEl,
      'warn',
      'Khong the bóc tach bai viet mot cach chinh xac bang bo trich xuat chinh; dang dung che do du phong (co the lan menu/quang cao).',
      [{ label: 'Xem ban goc', onClick: () => history.back() }]
    );
  }

  const { root, sentenceRefs } = renderArticle(doc);
  rootEl.appendChild(root);
  wireHighlightSync(root, sentenceRefs);

  const cacheKey = articleCacheKey(doc.url);
  const allSentences = collectAllSentences(doc);
  const diskCache = await readArticleCache(cacheKey);
  const inMemoryTranslations = new Map<string, { text: string; detectedLang?: string }>(
    diskCache ? Object.entries(diskCache.translations) : []
  );

  // Prime any already-cached sentences into the DOM before any network
  // activity starts, so a revisit reads "gan nhu tuc thi" (cache hit).
  const pending: Sentence[] = [];
  for (const sentence of allSentences) {
    const hit = inMemoryTranslations.get(hashString(sentence.text));
    if (hit) {
      const refs = sentenceRefs.get(sentence.id);
      if (refs) fillTranslation(refs.transEl, hit.text);
    } else {
      pending.push(sentence);
    }
  }

  wireSelectionSave(root, rootEl, {
    translateTerm: (text) => translateSingle(doc.url, settings.targetLang, text),
    saveEntry: async ({ term, translation, contextText, contextStart, contextEnd }) => {
      await addVocabEntry(
        buildVocabEntry({
          term,
          translation,
          contextText,
          contextStart,
          contextEnd,
          sourceUrl: doc.url,
          sourceTitle: doc.title,
        })
      );
    },
  });

  await runTranslationOrchestrator({
    doc,
    pending,
    sentenceRefs,
    cacheKey,
    targetLang: settings.targetLang,
    inMemoryTranslations,
    progressBar,
    progressLabel,
    bannersEl,
    rootEl,
    totalSentenceCount: allSentences.length,
  });
}

main().catch((err: unknown) => {
  console.error('Bilingual Reader failed to initialize', err);
  const bannersEl = document.getElementById('br-banners');
  if (bannersEl) {
    showBanner(bannersEl, 'error', `Loi khong mong muon: ${err instanceof Error ? err.message : String(err)}`, []);
  }
});
