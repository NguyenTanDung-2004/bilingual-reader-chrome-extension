// DOM -> ArticleDoc. This is the only module allowed to read the live
// source page's DOM. It knows nothing about translation, storage, or
// messaging - it hands back a plain ArticleDoc (see core/types.ts) built
// entirely from a tag whitelist (core/inline.ts), so no raw site HTML ever
// crosses into the extension's privileged pages.
import { Readability } from '@mozilla/readability';
import type { ArticleDoc, Block, ImageBlock, Sentence, TextBlockKind } from '../core/types';
import { extractInline, resolveSafeImageSrc, sanitizeOpaqueHtml } from '../core/inline';
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

/**
 * Never descend into these, on either extraction path. Non-prose or actively
 * unsafe: nothing inside them can become a Block.
 */
const SKIP_TAGS_ALWAYS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'SVG',
  'CANVAS',
  'AUDIO',
  'VIDEO',
]);

/**
 * Page furniture, skipped only on the raw-DOM fallback path. Readability has
 * already removed the real navigation and sidebars from its own output, so
 * applying this list there as well was costing us legitimate content - a hero
 * image in <header>, or a pull-quote in <aside> inside the article body.
 */
const SKIP_TAGS_CHROME = new Set([
  'NAV',
  'ASIDE',
  'FOOTER',
  'HEADER',
  'FORM',
  'BUTTON',
  'SELECT',
  'TEXTAREA',
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

/** Non-standard lazy-loading attributes that hold a single URL. Checked in order. */
const LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc'];
/** Non-standard lazy-loading attributes that hold a srcset-shaped list. */
const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];

/**
 * Splits a srcset into candidates the way the HTML parser does: on whitespace
 * first, treating a trailing comma as the candidate separator.
 *
 * Naively splitting the whole string on ',' breaks any URL containing a comma
 * - which is every Cloudinary/imgix-style transform URL
 * ('.../upload/w_300,h_200,c_fill/pic.jpg'). That produced a garbage fragment
 * ('c_fill/pic.jpg') that still carried the highest 'w' descriptor, so it won
 * the pick, resolved against the page URL into a valid-looking https URL, and
 * sailed through every downstream check as a 404.
 */
function parseSrcset(srcset: string): { url: string; score: number }[] {
  const candidates: { url: string; score: number }[] = [];
  const tokens = srcset.trim().split(/\s+/).filter(Boolean);

  let i = 0;
  while (i < tokens.length) {
    const urlToken = tokens[i]!;
    i++;
    const url = urlToken.replace(/,+$/, '');
    // 'w' descriptors are pixel widths, 'x' are density multipliers. A single
    // srcset never legally mixes them, so scaling 'x' keeps the two orderable.
    let score = 1;
    if (!urlToken.endsWith(',')) {
      // Descriptors run until a token ends the candidate with a comma.
      while (i < tokens.length) {
        const token = tokens[i]!;
        i++;
        const descriptor = token.replace(/,+$/, '');
        if (descriptor.endsWith('w')) score = Number.parseFloat(descriptor) || score;
        else if (descriptor.endsWith('x')) score = (Number.parseFloat(descriptor) || 1) * 1000;
        if (token.endsWith(',')) break;
      }
    }
    if (url) candidates.push({ url, score });
  }
  return candidates;
}

/** Highest-resolution candidate in a srcset attribute, or '' if there is none. */
function pickFromSrcset(srcset: string): string {
  let best = '';
  let bestScore = -1;
  for (const candidate of parseSrcset(srcset)) {
    if (candidate.score > bestScore) {
      bestScore = candidate.score;
      best = candidate.url;
    }
  }
  return best;
}

/** Reads the srcset/src off the <source> children of a <picture>, best candidate first. */
function pickFromPicture(picture: Element): string {
  for (const source of Array.from(picture.querySelectorAll('source'))) {
    for (const attr of ['srcset', ...LAZY_SRCSET_ATTRS]) {
      const raw = source.getAttribute(attr);
      const picked = raw ? pickFromSrcset(raw) : '';
      if (picked) return picked;
    }
    const src = source.getAttribute('src');
    if (src && src.trim()) return src.trim();
  }
  return '';
}

/**
 * Every raw (possibly relative) source an <img>/<picture> offers, best first.
 *
 * Returning a *list* rather than one winner matters: the previous version
 * returned the first non-empty attribute, so a single bad candidate killed the
 * image outright even when a good one sat right behind it. Two real cases:
 *
 *  - A lazy-loader parks a placeholder in `src` - a 1x1 gif, a spinner, a
 *    `data:` URI - and keeps the real URL in `data-src`. Reading `src` first
 *    rendered the placeholder, or, once `data:` was rejected, dropped the
 *    image and never looked at `data-src`.
 *  - A carousel widget (geeksforgeeks.org) assigns the *first* slide's URL to
 *    the `src` of every slide and puts each real URL in `data-src`, so `src`
 *    is a valid https URL that is nonetheless the wrong picture.
 *
 * Hence lazy attributes rank above `src`: when a page bothers to carry a
 * second URL, that one is the real image.
 */
function imageSrcCandidates(el: Element): string[] {
  const candidates: string[] = [];
  const push = (raw: string | null | undefined): void => {
    const value = raw?.trim();
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  if (el.tagName.toUpperCase() === 'PICTURE') {
    const inner = el.querySelector('img');
    if (inner) return imageSrcCandidates(inner);
    push(pickFromPicture(el));
    return candidates;
  }

  for (const attr of LAZY_SRC_ATTRS) push(el.getAttribute(attr));
  for (const attr of LAZY_SRCSET_ATTRS) push(pickFromSrcset(el.getAttribute(attr) ?? ''));
  push(pickFromSrcset(el.getAttribute('srcset') ?? ''));
  const parent = el.parentElement;
  if (parent && parent.tagName.toUpperCase() === 'PICTURE') push(pickFromPicture(parent));
  push(el.getAttribute('src'));

  return candidates;
}

/** A declared HTML width/height, if it is a usable positive integer. */
function readDeclaredSize(el: Element, name: 'width' | 'height'): number | undefined {
  const raw = el.getAttribute(name);
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Builds an ImageBlock from an <img>/<picture>, or null when none of its
 * candidate sources is safe. Deliberately does no size- or class-based
 * filtering - guessing which images are ads is what loses wanted
 * illustrations. (Readability does its own filtering upstream, and is not
 * trustworthy about images either: see prepareImages.)
 */
function makeImageBlock(el: Element, baseUrl: string, inline = false): ImageBlock | null {
  let src: string | undefined;
  for (const candidate of imageSrcCandidates(el)) {
    src = resolveSafeImageSrc(candidate, baseUrl);
    if (src) break; // first candidate that is both present and safe wins
  }
  if (!src) return null;

  const attrSource = el.tagName.toUpperCase() === 'PICTURE' ? (el.querySelector('img') ?? el) : el;
  const block: ImageBlock = { kind: 'img', id: makeBlockId(), src };
  const alt = attrSource.getAttribute('alt');
  if (alt) block.alt = alt;
  const width = readDeclaredSize(attrSource, 'width');
  if (width !== undefined) block.width = width;
  const height = readDeclaredSize(attrSource, 'height');
  if (height !== undefined) block.height = height;
  if (inline) block.inline = true;
  return block;
}

/**
 * Every image-bearing element under `root`, in document order. A <picture>
 * with an inner <img> is represented by that <img> (which knows how to read
 * its siblings' srcset) rather than counted twice.
 */
function imageElementsIn(root: Element): Element[] {
  return Array.from(root.querySelectorAll('img, picture')).filter((el) => {
    if (el.tagName.toUpperCase() === 'PICTURE' && el.querySelector('img')) return false;
    // visit() refuses to descend into these, so a query that ignored them
    // disagreed with the walk - a <noscript> duplicate of a lazy image (which
    // DOMParser does expose as real DOM) came through as a second block.
    for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
      if (SKIP_TAGS_ALWAYS.has(p.tagName.toUpperCase())) return false;
    }
    return true;
  });
}

// --- Pre-processing: making images survive Readability -----------------------
//
// Readability is an *article text* extractor, and it actively deletes image
// containers. _cleanConditionally('div') drops any <div> holding more than two
// images and almost no text (Readability.js:2148) - which is the exact shape of
// every carousel, gallery and slider. On geeksforgeeks.org that removed all
// eight article images before this module ever saw them, so no amount of
// cleverness in pickImageSrc could have recovered them.
//
// So we run over the *clone* before parsing and (a) turn non-standard image
// carriers into real <img>, (b) hoist lazy sources into `src`, and (c) lift
// images out of the containers that are about to be deleted.
//
// Every step mutates a detached clone only - never the live page.

/** Tags whose `src`/`data-src` is not an image, or is already handled natively. */
const NON_IMAGE_SRC_TAGS = new Set([
  'IMG',
  'PICTURE',
  'SOURCE',
  'SCRIPT',
  'IFRAME',
  'FRAME',
  'VIDEO',
  'AUDIO',
  'EMBED',
  'OBJECT',
  'INPUT',
  'TRACK',
  'LINK',
]);

const IMAGE_URL_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)(?:[?#]|$)/i;

/**
 * Gives a real <img> to elements that carry an image URL without being an
 * <img> - custom elements especially. geeksforgeeks.org ships its article
 * images as `<gfg-carousel-content src="...webp">`, which its own script later
 * upgrades on the live DOM; if extraction wins that race, or the script never
 * runs, the URL is there but invisible to any `img` selector.
 *
 * The <img> is appended rather than swapped in, so nothing else the element
 * holds is lost.
 */
function normalizeImageCarriers(root: Element): void {
  const ownerDoc = root.ownerDocument;
  if (!ownerDoc) return;

  for (const el of Array.from(root.querySelectorAll('[src], [data-src], [data-srcset]'))) {
    const tag = el.tagName.toUpperCase();
    if (NON_IMAGE_SRC_TAGS.has(tag) || SKIP_TAGS_ALWAYS.has(tag)) continue;
    if (el.querySelector('img')) continue; // already carries a real image

    const candidates = imageSrcCandidates(el);
    if (candidates.length === 0) continue;
    // A custom element (its name must contain a hyphen) carrying a src is
    // taken at its word; anything else has to look like an image URL.
    if (!tag.includes('-') && !candidates.some((c) => IMAGE_URL_RE.test(c))) continue;

    const img = ownerDoc.createElement('img');
    img.setAttribute('src', candidates[0]!);
    for (const name of ['alt', 'width', 'height']) {
      const value = el.getAttribute(name);
      if (value) img.setAttribute(name, value);
    }
    el.appendChild(img);
  }
}

/**
 * Hoists the best candidate source into `src` on every <img>. This is what
 * makes a lazy image legible to Readability (which discards an <img> with no
 * image-ish attribute) and to sanitizeOpaqueHtml, which only reads `src`, so
 * a srcset-only image inside a <table> used to be stripped.
 */
function promoteLazyImageSources(root: Element): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const best = imageSrcCandidates(img)[0];
    if (best && img.getAttribute('src') !== best) img.setAttribute('src', best);
  }
}

/**
 * Mirrors the two image-count rules in Readability's _cleanConditionally
 * (Readability.js:2144-2148) that decide a container is not article content:
 * more than one image with too few paragraphs, or more than two images with
 * essentially no text. Also mirrors the comma gate above them, which skips the
 * whole check for prose-heavy containers.
 *
 * A container with no images is never "doomed" for our purposes - there is
 * nothing in it to rescue.
 */
function readabilityWouldDelete(el: Element): boolean {
  const imgCount = el.getElementsByTagName('img').length;
  if (imgCount === 0) return false;
  if (((el.textContent ?? '').match(/,/g) ?? []).length >= 10) return false;

  const pCount = el.getElementsByTagName('p').length;
  const textLength = (el.textContent ?? '').trim().length;
  return (imgCount > 1 && pCount / imgCount < 0.5) || (textLength < 25 && imgCount > 2);
}

/**
 * Lifts images out of containers Readability is about to delete, into plain
 * <figure> wrappers at the nearest level it will keep.
 *
 * Wrapping the cluster in a <figure> instead does not work, even though
 * _cleanConditionally exempts anything with a <figure> ancestor: that lookup
 * is depth-limited to 3 (_hasAncestorTag, Readability.js:1878). A carousel
 * nests its images five levels down, so the exemption never reached them, and
 * the outer wrapper - a div holding eight images and no paragraphs - was
 * deleted anyway, taking the <figure> with it. Measured on
 * geeksforgeeks.org/web-tech/web-technology: 0 of 8 images survived.
 *
 * The doomed container itself is left in place rather than removed. It may
 * still hold text that Readability would have kept, and that judgement is not
 * ours to pre-empt; emptied of images, it no longer matches these rules.
 */
/** Structural containers that are the article itself; hoisting out of them is meaningless. */
const STOP_HOIST_TAGS = new Set(['BODY', 'ARTICLE', 'MAIN', 'FIGURE']);

function hoistImagesFromDoomedContainers(root: Element): void {
  const ownerDoc = root.ownerDocument;
  if (!ownerDoc) return;

  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (img.closest('figure')) continue; // already safe, or moved by an earlier pass

    // Take the *outermost* doomed ancestor, and do not stop at a safe one on
    // the way up: a gallery wraps each image in its own single-image cell,
    // which is safe on its own, while the grid holding all of them is not -
    // and deleting the grid takes every cell with it.
    let doomed: Element | null = null;
    for (let p = img.parentElement; p && p !== root; p = p.parentElement) {
      if (STOP_HOIST_TAGS.has(p.tagName.toUpperCase())) break;
      if (readabilityWouldDelete(p)) doomed = p;
    }
    // Nothing above this image is at risk - a lone illustration in a
    // paragraph, say. Hoisting it would only break its reading position.
    if (!doomed) continue;

    const parent = doomed.parentNode;
    if (!parent) continue;

    for (const inner of Array.from(doomed.querySelectorAll('img'))) {
      const figure = ownerDoc.createElement('figure');
      parent.insertBefore(figure, doomed);
      figure.appendChild(inner);
    }
  }
}

/** Runs the three image-rescue passes over a detached clone, in order. */
function prepareImages(root: Element): void {
  normalizeImageCarriers(root);
  promoteLazyImageSources(root);
  hoistImagesFromDoomedContainers(root);
}

/** First text node under `el` carrying actual characters - used to order promoted images against the text. */
function firstMeaningfulTextNode(el: Element): Node | null {
  const doc = el.ownerDocument;
  if (!doc) return null;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node.textContent ?? '').trim().length > 0) return node;
  }
  return null;
}

/**
 * For an `<li>`, determines whether it belongs to an `<ol>` and, if so, the
 * number the browser would have rendered for it - honoring the list's
 * `start`/`reversed` attributes and any `value` override on an earlier
 * sibling, the same way native list numbering does. Must run before the
 * source tree is torn down (Readability output or the live-page fallback),
 * since the reader itself never sees a real `<ol>`/`<ul>` wrapper.
 */
function computeListInfo(li: Element): { ordered: boolean; listNumber?: number } | undefined {
  const parent = li.parentElement;
  if (!parent) return undefined;
  const parentTag = parent.tagName.toUpperCase();
  if (parentTag === 'UL') return { ordered: false };
  if (parentTag !== 'OL') return undefined;

  const startAttr = Number.parseInt(parent.getAttribute('start') ?? '', 10);
  const reversed = parent.hasAttribute('reversed');
  const step = reversed ? -1 : 1;
  let n = Number.isFinite(startAttr) ? startAttr : reversed ? Array.from(parent.children).filter((c) => c.tagName.toUpperCase() === 'LI').length : 1;

  for (const sibling of Array.from(parent.children)) {
    if (sibling.tagName.toUpperCase() !== 'LI') continue;
    const valueAttr = Number.parseInt(sibling.getAttribute('value') ?? '', 10);
    if (Number.isFinite(valueAttr)) n = valueAttr;
    if (sibling === li) return { ordered: true, listNumber: n };
    n += step;
  }
  return { ordered: true, listNumber: n }; // unreachable when li is actually a child of parent
}

interface CollectOptions {
  /** True on the raw-DOM fallback path, where SKIP_TAGS_CHROME still has to be applied by hand. */
  skipChrome: boolean;
}

/**
 * Walks a content root (either Readability's cleaned output, parsed into a
 * detached document, or a raw-DOM fallback subtree) and collects Block[].
 * Generic wrapper elements (div/section/...) are recursed into rather than
 * becoming a block themselves, except when they are a childless text leaf
 * (common on div-soup sites with no semantic <p> tags).
 */
function collectBlocks(root: Element, baseUrl: string, opts: CollectOptions): Block[] {
  const blocks: Block[] = [];
  // An <img> can be reachable both as a descendant of a text element and, on
  // a later visit, on its own. Emitting each element at most once keeps a
  // promoted inline image from also appearing as a standalone block.
  const seenImages = new WeakSet<Element>();
  // A widget often renders the same picture twice (a slide plus its blurred
  // backdrop), which would otherwise become two identical rows. Repeating one
  // URL adds no content, so the first occurrence wins.
  const emittedSrcs = new Set<string>();

  /** Emits one ImageBlock per not-yet-seen image element, and reports how many made it. */
  function pushImages(els: Element[], inline: boolean, caption?: Sentence[]): number {
    let emitted = 0;
    for (const el of els) {
      if (seenImages.has(el)) continue;
      const block = makeImageBlock(el, baseUrl, inline);
      if (!block) continue;
      if (emittedSrcs.has(block.src)) continue;
      emittedSrcs.add(block.src);
      seenImages.add(el);
      // The caption belongs to the figure as a whole; attach it to the first
      // image that actually rendered rather than repeating it per image.
      if (emitted === 0 && caption && caption.length > 0) block.caption = caption;
      blocks.push(block);
      emitted++;
    }
    return emitted;
  }

  function pushTextBlock(
    kind: TextBlockKind,
    el: Element,
    listInfo?: { ordered: boolean; listNumber?: number }
  ): void {
    const sentences = sentencesFromElement(el, baseUrl);
    // Images wrapped in a text element (`<p><img></p>`, a list item, an inline
    // icon) used to be dropped outright, since only the text was read. Lift
    // them out into their own full-width rows instead: an <img> left inline
    // would render on the original side only and push that column's sentences
    // out of alignment with their translations.
    const images = imageElementsIn(el).filter((img) => !seenImages.has(img));
    const textNode = images.length > 0 ? firstMeaningfulTextNode(el) : null;
    const imagesFirst =
      !textNode ||
      (images[0]!.compareDocumentPosition(textNode) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    if (imagesFirst) pushImages(images, true);
    if (sentences.length > 0) blocks.push({ kind, id: makeBlockId(), sentences, ...listInfo });
    if (!imagesFirst) pushImages(images, true);
  }

  function visit(el: Element): void {
    const tag = el.tagName.toUpperCase(); // SVG-namespace elements report lowercase
    if (SKIP_TAGS_ALWAYS.has(tag)) return;
    if (opts.skipChrome && SKIP_TAGS_CHROME.has(tag)) return;

    if (tag === 'FIGURE') {
      const images = imageElementsIn(el);
      if (images.length > 0) {
        const captionEl = el.querySelector('figcaption');
        const caption = captionEl ? sentencesFromElement(captionEl, baseUrl) : undefined;
        // A figure whose images all turned out to be unusable still has a
        // caption worth reading; it used to be discarded along with them.
        if (pushImages(images, false, caption) === 0 && caption && caption.length > 0) {
          blocks.push({ kind: 'p', id: makeBlockId(), sentences: caption });
        }
        return;
      }
    }
    if (tag === 'IMG' || tag === 'PICTURE') {
      pushImages([el], false);
      return;
    }
    if (tag === 'PRE') {
      blocks.push({ kind: 'code', id: makeBlockId(), html: sanitizeOpaqueHtml(el.outerHTML, baseUrl) });
      return;
    }
    if (tag === 'TABLE') {
      blocks.push({ kind: 'table', id: makeBlockId(), html: sanitizeOpaqueHtml(el.outerHTML, baseUrl) });
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
      pushTextBlock('li', el, computeListInfo(el));
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
  // No tag filter here: the selector already only yields div/section, and the
  // skip lists are applied during the walk instead.
  const candidates = Array.from(doc.body.querySelectorAll<HTMLElement>('div, section'));
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
 * Collects blocks off the fallback root. The root is cloned first because
 * prepareImages mutates what it is given, and this path starts from the live
 * page - which must be left exactly as the user sees it.
 */
function collectFallbackBlocks(doc: Document, url: string): Block[] {
  const root = pickFallbackRoot(doc).cloneNode(true) as Element;
  prepareImages(root);
  return collectBlocks(root, url, { skipChrome: true });
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
    // Must happen before parse(): Readability deletes image containers, and
    // once it has, there is nothing left for collectBlocks to find.
    if (clone.body) prepareImages(clone.body);
    const article = new Readability(clone).parse();
    if (article && article.content && article.textContent.trim().length >= MIN_READABILITY_CHARS) {
      const parsed = new DOMParser().parseFromString(article.content, 'text/html');
      const blocks = collectBlocks(parsed.body, url, { skipChrome: false });
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
  const blocks = readabilityBlocks ?? collectFallbackBlocks(doc, url);

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
