import { describe, expect, it } from 'vitest';
import { fillTranslation, renderArticle } from './render';
import type { ArticleDoc } from '../core/types';

function baseDoc(overrides: Partial<ArticleDoc> = {}): ArticleDoc {
  return {
    id: 'doc1',
    url: 'https://example.com/a',
    title: 'Title',
    capturedAt: 0,
    blocks: [],
    ...overrides,
  };
}

describe('renderArticle', () => {
  it('renders a paragraph block as a left/right cell pair with one grid child sequence', () => {
    const doc = baseDoc({
      blocks: [
        {
          kind: 'p',
          id: 'b1',
          sentences: [
            { id: 's1', text: 'Hello.', runs: [] },
            { id: 's2', text: 'World.', runs: [] },
          ],
        },
      ],
    });
    const { root, sentenceRefs } = renderArticle(doc);
    expect(root.className).toBe('br-grid');
    expect(root.children).toHaveLength(2); // left <p>, right <p>
    expect(root.children[0]?.tagName).toBe('P');
    expect(root.children[1]?.tagName).toBe('P');
    expect(sentenceRefs.size).toBe(2);
    const s1 = sentenceRefs.get('s1')!;
    expect(s1.origEl.textContent).toBe('Hello.');
    expect(s1.transEl.classList.contains('br-skeleton')).toBe(true);
  });

  it('renders untranslated sentences with a skeleton placeholder and no text', () => {
    const doc = baseDoc({
      blocks: [{ kind: 'p', id: 'b1', sentences: [{ id: 's1', text: 'Hi.', runs: [] }] }],
    });
    const { sentenceRefs } = renderArticle(doc);
    const { transEl } = sentenceRefs.get('s1')!;
    expect(transEl.classList.contains('br-skeleton')).toBe(true);
    expect(transEl.getAttribute('aria-busy')).toBe('true');
  });

  it('renders an already-translated sentence directly, no skeleton', () => {
    const doc = baseDoc({
      blocks: [
        { kind: 'p', id: 'b1', sentences: [{ id: 's1', text: 'Hi.', runs: [], translation: 'Chao.' }] },
      ],
    });
    const { sentenceRefs } = renderArticle(doc);
    const { transEl } = sentenceRefs.get('s1')!;
    expect(transEl.classList.contains('br-skeleton')).toBe(false);
    expect(transEl.textContent).toBe('Chao.');
  });

  it('fillTranslation clears the skeleton state and sets the text', () => {
    const doc = baseDoc({
      blocks: [{ kind: 'p', id: 'b1', sentences: [{ id: 's1', text: 'Hi.', runs: [] }] }],
    });
    const { sentenceRefs } = renderArticle(doc);
    const { transEl } = sentenceRefs.get('s1')!;
    fillTranslation(transEl, 'Chao ban.');
    expect(transEl.classList.contains('br-skeleton')).toBe(false);
    expect(transEl.hasAttribute('aria-busy')).toBe(false);
    expect(transEl.textContent).toBe('Chao ban.');
  });

  it('renders a code block as one full-span cell and never creates a translation cell for it', () => {
    const doc = baseDoc({
      blocks: [{ kind: 'code', id: 'b1', html: '<pre><code>console.log(1)</code></pre>' }],
    });
    const { root } = renderArticle(doc);
    expect(root.children).toHaveLength(1);
    expect(root.children[0]?.classList.contains('br-cell--full')).toBe(true);
    expect(root.children[0]?.innerHTML).toContain('console.log(1)');
  });

  it('re-sanitizes opaque html at render time even if it were somehow already dirty', () => {
    const doc = baseDoc({
      blocks: [{ kind: 'code', id: 'b1', html: '<pre><code>ok<script>alert(1)</script></code></pre>' }],
    });
    const { root } = renderArticle(doc);
    expect(root.children[0]?.innerHTML).not.toContain('script');
  });

  it('renders an image block as a single full-span cell with lazy-loading and no-referrer attributes', () => {
    const doc = baseDoc({
      blocks: [{ kind: 'img', id: 'b1', src: 'https://example.com/x.png', alt: 'desc' }],
    });
    const { root } = renderArticle(doc);
    const img = root.querySelector('img')!;
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img.getAttribute('alt')).toBe('desc');
  });

  it('renders an image caption as its own left/right sentence row', () => {
    const doc = baseDoc({
      blocks: [
        {
          kind: 'img',
          id: 'b1',
          src: 'https://example.com/x.png',
          caption: [{ id: 'c1', text: 'A caption.', runs: [] }],
        },
      ],
    });
    const { root, sentenceRefs } = renderArticle(doc);
    expect(root.children).toHaveLength(3); // image cell + caption left + caption right
    expect(sentenceRefs.get('c1')?.origEl.textContent).toBe('A caption.');
  });

  it('collapses the image row on a load error (R7)', () => {
    const doc = baseDoc({ blocks: [{ kind: 'img', id: 'b1', src: 'https://example.com/broken.png' }] });
    const { root } = renderArticle(doc);
    const cell = root.children[0] as HTMLElement;
    const img = cell.querySelector('img')!;
    img.dispatchEvent(new Event('error'));
    expect(cell.style.display).toBe('none');
  });
});
