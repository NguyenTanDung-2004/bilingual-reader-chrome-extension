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
import { buildInlineFragment, sanitizeOpaqueHtml } from '../core/inline';

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
      const imgCell = document.createElement('div');
      imgCell.className = 'br-cell br-cell--full br-image-cell';
      const img = document.createElement('img');
      img.src = block.src;
      if (block.alt) img.alt = block.alt;
      img.setAttribute('loading', 'lazy');
      img.setAttribute('referrerpolicy', 'no-referrer');
      // R7: a hotlink-blocked/broken image collapses its row instead of showing a broken-image icon.
      img.addEventListener(
        'error',
        () => {
          imgCell.style.display = 'none';
        },
        { once: true }
      );
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
    }
    root.appendChild(left);
    root.appendChild(right);
  }

  return { root, sentenceRefs };
}
