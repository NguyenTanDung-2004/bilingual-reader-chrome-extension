// ArticleDoc -> DOM. Pure rendering: builds a single CSS Grid (decision
// #9 - no scroll-sync JS at all; two-column alignment comes purely from
// each block contributing one grid row via normal document-order
// auto-placement). Every node is built with createElement/textContent -
// the only place untrusted-shaped content ever reaches innerHTML is the
// opaque code/table block path below, and even there the content was
// already sanitized once at extraction time (content/extract.ts) and is
// re-sanitized here, defense in depth, exactly like buildInlineFragment
// re-validates hrefs instead of trusting a stored InlineRun blindly.
import { isTextBlock, type ArticleDoc, type Sentence, type TextBlockKind } from '../core/types';
import { buildInlineFragment, isSafeImageSrc, sanitizeOpaqueHtml } from '../core/inline';

const TAG_FOR_KIND: Record<TextBlockKind, string> = {
  p: 'p',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  li: 'li',
  quote: 'blockquote',
};

export interface RenderedSentenceRefs {
  origEl: HTMLElement;
  transEl: HTMLElement;
}

export interface RenderResult {
  root: HTMLElement;
  /** Keyed by Sentence.id - interactions.ts and the translation orchestrator use this to find nodes without re-querying the DOM. */
  sentenceRefs: Map<string, RenderedSentenceRefs>;
}

function makeSentenceSpan(sentence: Sentence, side: 'orig' | 'trans'): HTMLElement {
  const span = document.createElement('span');
  span.className = 'br-sentence';
  span.dataset.sid = sentence.id;
  if (side === 'orig') {
    span.appendChild(buildInlineFragment(sentence.text, sentence.runs));
  } else if (sentence.translation !== undefined) {
    span.textContent = sentence.translation;
  } else {
    span.classList.add('br-skeleton');
    span.setAttribute('aria-busy', 'true');
  }
  return span;
}

/**
 * Wraps an `<li>`'s existing children in a body span and prepends a marker
 * span ahead of it. Needed because the reader renders each list item as its
 * own standalone grid row (decision #9) rather than inside a real
 * `<ol>`/`<ul>`, so native list numbering never applies - see TextBlock.ordered.
 */
function markLi(li: HTMLElement, markerText: string): void {
  const body = document.createElement('span');
  body.className = 'br-li-body';
  while (li.firstChild) body.appendChild(li.firstChild);
  const marker = document.createElement('span');
  marker.className = 'br-li-marker';
  marker.textContent = markerText;
  li.append(marker, body);
}

/** Sets/replaces a sentence span's translation content in place, clearing the skeleton state. Used by the orchestrator as results arrive. */
export function fillTranslation(transEl: HTMLElement, translation: string): void {
  transEl.classList.remove('br-skeleton');
  transEl.removeAttribute('aria-busy');
  transEl.textContent = translation;
}

export function markTranslationError(transEl: HTMLElement): void {
  transEl.classList.remove('br-skeleton');
  transEl.removeAttribute('aria-busy');
  transEl.classList.add('br-translate-error');
  transEl.textContent = '⚠'; // small inline warning glyph; reader.ts wires a retry affordance around the block
}

export function renderArticle(doc: ArticleDoc): RenderResult {
  const root = document.createElement('div');
  root.className = 'br-grid';
  const sentenceRefs = new Map<string, RenderedSentenceRefs>();

  function fillTextEl(tag: string, sentences: Sentence[], side: 'orig' | 'trans'): HTMLElement {
    const el = document.createElement(tag);
    sentences.forEach((sentence, i) => {
      if (i > 0) el.appendChild(document.createTextNode(' '));
      const span = makeSentenceSpan(sentence, side);
      el.appendChild(span);
      const existing = sentenceRefs.get(sentence.id) ?? ({} as Partial<RenderedSentenceRefs>);
      if (side === 'orig') existing.origEl = span;
      else existing.transEl = span;
      sentenceRefs.set(sentence.id, existing as RenderedSentenceRefs);
    });
    return el;
  }

  for (const block of doc.blocks) {
    if (block.kind === 'img') {
      // Not trusted just because it is in an ArticleDoc: this may have been
      // read back from on-disk cache, so the protocol is re-checked here the
      // same way buildInlineFragment re-checks a stored href.
      if (!isSafeImageSrc(block.src)) continue;

      const imgCell = document.createElement('div');
      imgCell.className = 'br-cell br-cell--full br-image-cell';
      if (block.inline) imgCell.classList.add('br-image-cell--inline');
      const img = document.createElement('img');
      img.src = block.src;
      if (block.alt) img.alt = block.alt;
      // Declared dimensions let the browser reserve the right box before the
      // (lazy) image arrives, so a late load cannot shift the grid and knock
      // the two columns out of alignment.
      if (block.width !== undefined) img.setAttribute('width', String(block.width));
      if (block.height !== undefined) img.setAttribute('height', String(block.height));
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      // No error handler: the old R7 behaviour hid the whole row when an image
      // failed, which turned every extraction bug into a silently missing
      // picture. A broken image now shows the browser's own marker, so the
      // gap is at least visible.
      //
      // No 'referrerpolicy' either, by preference rather than necessity: this
      // page is served from chrome-extension://<id>, so whatever referrer it
      // sends is never the source page's URL and cannot satisfy a CDN's
      // hotlink check. Dropping the attribute does not rescue those images.
      imgCell.appendChild(img);
      root.appendChild(imgCell);

      if (block.caption && block.caption.length > 0) {
        const left = fillTextEl('figcaption', block.caption, 'orig');
        const right = fillTextEl('figcaption', block.caption, 'trans');
        left.className = 'br-cell br-cell--left';
        right.className = 'br-cell br-cell--right';
        root.appendChild(left);
        root.appendChild(right);
      }
      continue;
    }

    if (block.kind === 'code' || block.kind === 'table') {
      const cell = document.createElement('div');
      cell.className = 'br-cell br-cell--full br-opaque';
      cell.innerHTML = sanitizeOpaqueHtml(block.html);
      root.appendChild(cell);
      continue;
    }

    if (!isTextBlock(block)) continue;
    const tag = TAG_FOR_KIND[block.kind];
    const left = fillTextEl(tag, block.sentences, 'orig');
    const right = fillTextEl(tag, block.sentences, 'trans');
    left.className = 'br-cell br-cell--left';
    right.className = 'br-cell br-cell--right';
    if (block.kind === 'li') {
      left.classList.add('br-li');
      right.classList.add('br-li');
      const markerText = block.ordered ? `${block.listNumber ?? 1}.` : '•';
      markLi(left, markerText);
      markLi(right, markerText);
    }
    root.appendChild(left);
    root.appendChild(right);
  }

  return { root, sentenceRefs };
}
