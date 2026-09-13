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

  it('renders an image block as a single full-span cell, sending the referrer like the source page does', () => {
    const doc = baseDoc({
      blocks: [{ kind: 'img', id: 'b1', src: 'https://example.com/x.png', alt: 'desc' }],
    });
    const { root } = renderArticle(doc);
    const img = root.querySelector('img')!;
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    expect(img.getAttribute('alt')).toBe('desc');
    // Deliberately absent: no-referrer made hotlink-protected CDNs reject
    // images the source page serves fine.
    expect(img.getAttribute('referrerpolicy')).toBeNull();
  });

  it('renders declared width/height so a late lazy image cannot shift the columns', () => {
    const doc = baseDoc({
      blocks: [{ kind: 'img', id: 'b1', src: 'https://example.com/x.png', width: 800, height: 400 }],
    });
    const { root } = renderArticle(doc);
    const img = root.querySelector('img')!;
    expect(img.getAttribute('width')).toBe('800');
    expect(img.getAttribute('height')).toBe('400');
  });

  it('marks an image lifted out of a text block so it renders at its natural size', () => {
    const doc = baseDoc({
      blocks: [{ kind: 'img', id: 'b1', src: 'https://example.com/icon.png', inline: true }],
    });
    const { root } = renderArticle(doc);
    const cell = root.children[0]!;
    expect(cell.classList.contains('br-image-cell--inline')).toBe(true);
    expect(cell.classList.contains('br-cell--full')).toBe(true);
  });

  it('skips an image block whose src has an unsafe protocol, even from cache', () => {
    const doc = baseDoc({
      blocks: [
        { kind: 'img', id: 'b1', src: 'javascript:alert(1)' },
        { kind: 'img', id: 'b2', src: 'data:image/svg+xml,%3Csvg onload=alert(1)%3E' },
        { kind: 'img', id: 'b3', src: 'https://example.com/ok.png' },
      ],
    });
    const { root } = renderArticle(doc);
    expect(root.querySelectorAll('img')).toHaveLength(1);
    expect(root.querySelector('img')!.getAttribute('src')).toBe('https://example.com/ok.png');
  });

  it('keeps an in-table image through render-time re-sanitization', () => {
    const doc = baseDoc({
      blocks: [
        {
          kind: 'table',
          id: 'b1',
          html: '<table><tbody><tr><td><img src="https://example.com/i.png" alt="i"></td></tr></tbody></table>',
        },
      ],
    });
    const { root } = renderArticle(doc);
    expect(root.querySelector('img')!.getAttribute('src')).toBe('https://example.com/i.png');
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

  // Supersedes the original R7 behaviour, which hid the row on any load
  // error. Combined with no-referrer that silently swallowed images the
  // source page shows, which is the bug this change exists to fix.
  it('keeps the image row on a load error instead of hiding it', () => {
    const doc = baseDoc({ blocks: [{ kind: 'img', id: 'b1', src: 'https://example.com/broken.png' }] });
    const { root } = renderArticle(doc);
    const cell = root.children[0] as HTMLElement;
    const img = cell.querySelector('img')!;
    img.dispatchEvent(new Event('error'));
    expect(cell.style.display).toBe('');
    expect(cell.querySelector('img')).not.toBeNull();
  });
});
