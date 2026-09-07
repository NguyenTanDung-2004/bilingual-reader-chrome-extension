// DOM -> ArticleDoc. This is the only module allowed to read the live
// source page's DOM. It knows nothing about translation, storage, or
// messaging - it hands back a plain ArticleDoc (see core/types.ts) built
// entirely from a tag whitelist (core/inline.ts), so no raw site HTML ever
// crosses into the extension's privileged pages.
import { Readability } from '@mozilla/readability';
import type { ArticleDoc, Block, ImageBlock, Sentence, TextBlockKind } from '../core/types';
import { extractInline, sanitizeOpaqueHtml } from '../core/inline';
import { splitSentencesWithOffsets } from '../core/segment';
import { makeBlockId, makeSentenceId, resetIdCounter } from '../core/ids';

/** Below this many characters of Readability's own textContent, treat it as a failure and fall back. */
const MIN_READABILITY_CHARS = 200;

const HEADING_TAGS: Record<string, TextBlockKind> = {
  H1: 'h1',
  H2: 'h2',
  H3: 'h3',
  H4: 'h3',
  H5: 'h3',
  H6: 'h3',
};

/** Never descend into these, in either the Readability output or the raw-DOM fallback path. */
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'SVG',
  'NAV',
  'ASIDE',
  'FOOTER',
  'HEADER',
  'FORM',
  'BUTTON',
  'SELECT',
  'TEXTAREA',
  'CANVAS',
  'AUDIO',
  'VIDEO',
]);

/** Flattens `el` to plain text + whitelisted inline runs, then splits into per-sentence Sentence objects with locally re-offset runs. */
function sentencesFromElement(el: Element, baseUrl: string): Sentence[] {
  const { text, runs } = extractInline(el, baseUrl);
  const pieces = splitSentencesWithOffsets(text);
  return pieces.map((piece) => {
    const localRuns = runs
      .filter((r) => r.start < piece.end && r.end > piece.start) // any overlap with this sentence
      .map((r) => ({
        ...r,
        start: Math.max(r.start, piece.start) - piece.start,
        end: Math.min(r.end, piece.end) - piece.start,
      }));
    return { id: makeSentenceId(), text: piece.text, runs: localRuns };
  });
}

function resolveUrl(src: string, baseUrl: string): string {
  try {
    return new URL(src, baseUrl).toString();
  } catch {
    return '';
  }
}

/**
 * Walks a content root (either Readability's cleaned output, parsed into a
 * detached document, or a raw-DOM fallback subtree) and collects Block[].
 * Generic wrapper elements (div/section/...) are recursed into rather than
 * becoming a block themselves, except when they are a childless text leaf
 * (common on div-soup sites with no semantic <p> tags).
 */
function collectBlocks(root: Element, baseUrl: string): Block[] {
  const blocks: Block[] = [];

  function pushTextBlock(kind: TextBlockKind, el: Element): void {
    const sentences = sentencesFromElement(el, baseUrl);
    if (sentences.length > 0) blocks.push({ kind, id: makeBlockId(), sentences });
  }

  function visit(el: Element): void {
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return;

    if (tag === 'FIGURE') {
      const img = el.querySelector('img');
      if (img) {
        const rawSrc = img.getAttribute('src') || img.getAttribute('data-src') || '';
        const src = resolveUrl(rawSrc, baseUrl);
        if (src) {
          const captionEl = el.querySelector('figcaption');
          const block: ImageBlock = {
            kind: 'img',
            id: makeBlockId(),
            src,
            alt: img.getAttribute('alt') || undefined,
            caption: captionEl ? sentencesFromElement(captionEl, baseUrl) : undefined,
          };
          blocks.push(block);
        }
        return;
      }
    }
    if (tag === 'IMG') {
      const rawSrc = el.getAttribute('src') || el.getAttribute('data-src') || '';
      const src = resolveUrl(rawSrc, baseUrl);
      if (src) blocks.push({ kind: 'img', id: makeBlockId(), src, alt: el.getAttribute('alt') || undefined });
      return;
    }
    if (tag === 'PRE') {
      blocks.push({ kind: 'code', id: makeBlockId(), html: sanitizeOpaqueHtml(el.outerHTML) });
      return;
    }
    if (tag === 'TABLE') {
      blocks.push({ kind: 'table', id: makeBlockId(), html: sanitizeOpaqueHtml(el.outerHTML) });
      return;
    }
    const headingKind = HEADING_TAGS[tag];
    if (headingKind) {
      pushTextBlock(headingKind, el);
      return;
    }
    if (tag === 'P') {
      pushTextBlock('p', el);
      return;
    }
    if (tag === 'LI') {
      // Known simplification: a nested <ul>/<ol> inside this <li> has its
      // text folded into the parent item rather than becoming its own
      // block. Acceptable for v1 - sentence-level reading still works.
      pushTextBlock('li', el);
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      pushTextBlock('quote', el);
      return;
    }

    if (el.children.length === 0) {
      // Leaf element with no block-level children (common on div-soup
      // sites that skip <p> entirely) - treat its text as a paragraph.
      pushTextBlock('p', el);
      return;
    }

    for (const child of Array.from(el.children)) visit(child);
  }

  visit(root);
  return blocks;
}

function pickFallbackRoot(doc: Document): Element {
  const main = doc.querySelector('main');
  if (main && (main.textContent ?? '').trim().length > 100) return main;

  const article = doc.querySelector('article');
  if (article && (article.textContent ?? '').trim().length > 100) return article;

  // Longest-cumulative-text heuristic among generic containers.
  const candidates = Array.from(doc.body.querySelectorAll<HTMLElement>('div, section')).filter(
    (el) => !SKIP_TAGS.has(el.tagName)
  );
  let best: Element = doc.body;
  let bestLen = 0;
  for (const el of candidates) {
    const len = (el.textContent ?? '').trim().length;
    if (len > bestLen) {
      bestLen = len;
      best = el;
    }
  }
  return best;
}

/**
 * Extracts an ArticleDoc from a live document. Tries @mozilla/readability
 * first (on a deep clone, since Readability mutates its input); falls back
 * to a <main>/<article>/longest-text heuristic when Readability fails or
 * returns too little content (R: "Readability fail" state, surfaced to the
 * reader via `usedFallbackExtraction`).
 */
export function extractArticle(doc: Document, url: string, id: string): ArticleDoc {
  resetIdCounter();

  let readabilityBlocks: Block[] | null = null;
  let readabilityMeta: { title?: string; byline?: string; siteName?: string; lang?: string } = {};

  try {
    const clone = doc.cloneNode(true) as Document;
    const article = new Readability(clone).parse();
    if (article && article.content && article.textContent.trim().length >= MIN_READABILITY_CHARS) {
      const parsed = new DOMParser().parseFromString(article.content, 'text/html');
      const blocks = collectBlocks(parsed.body, url);
      if (blocks.length > 0) {
        readabilityBlocks = blocks;
        readabilityMeta = {
          title: article.title || undefined,
          byline: article.byline || undefined,
          siteName: article.siteName || undefined,
          lang: article.lang || undefined,
        };
      }
    }
  } catch {
    // Readability threw (malformed DOM, etc.) - fall through to the heuristic below.
    readabilityBlocks = null;
  }

  const usedFallback = readabilityBlocks === null;
  const blocks = readabilityBlocks ?? collectBlocks(pickFallbackRoot(doc), url);

  return {
    id,
    url,
    title: readabilityMeta.title || doc.title || url,
    byline: readabilityMeta.byline,
    siteName: readabilityMeta.siteName,
    srcLang: readabilityMeta.lang || doc.documentElement.getAttribute('lang') || undefined,
    capturedAt: Date.now(),
    blocks,
    usedFallbackExtraction: usedFallback,
  };
}
