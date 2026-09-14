import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { extractArticle } from './extract';
import type { Block } from '../core/types';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface FixtureCase {
  file: string;
  url: string;
}

const FIXTURES: FixtureCase[] = [
  { file: 'wikipedia.html', url: 'https://en.wikipedia.org/wiki/Web_scraping' },
  { file: 'mdn.html', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch' },
  { file: 'substack.html', url: 'https://www.astralcodexten.com/p/nicholas-decker-in-hell' },
  { file: 'bbc.html', url: 'https://www.bbc.com/future/article/hidden-benefits-of-doing-nothing' },
  { file: 'medium.html', url: 'https://medium.com/free-code-camp/how-i-cut-my-deploy-time-in-half' },
];

function loadFixtureDocument(file: string, url: string): Document {
  const html = readFileSync(path.join(fixturesDir, file), 'utf-8');
  const dom = new JSDOM(html, { url });
  return dom.window.document;
}

function imageBlocks(blocks: Block[]): Extract<Block, { kind: 'img' }>[] {
  return blocks.filter((b): b is Extract<Block, { kind: 'img' }> => b.kind === 'img');
}

function allText(blocks: Block[]): string {
  return blocks
    .flatMap((b) => {
      if (b.kind === 'img') return b.caption?.map((s) => s.text) ?? [];
      if (b.kind === 'code' || b.kind === 'table') return [b.html];
      if ('sentences' in b) return b.sentences.map((s) => s.text);
      return [];
    })
    .join(' \n ');
}

describe('extractArticle on real-world-shaped fixtures', () => {
  for (const { file, url } of FIXTURES) {
    it(`extracts a non-trivial ArticleDoc from ${file}`, () => {
      const document = loadFixtureDocument(file, url);
      const doc = extractArticle(document, url, 'test-id');

      expect(doc.id).toBe('test-id');
      expect(doc.url).toBe(url);
      expect(doc.title.trim().length).toBeGreaterThan(0);
      expect(doc.blocks.length).toBeGreaterThan(3);

      const text = allText(doc.blocks);
      // Chrome/noise that must never leak into extracted content.
      expect(text).not.toMatch(/dataLayer/);
      expect(text).not.toMatch(/Accept all/);
      expect(text).not.toMatch(/Sign in/);
      expect(text).not.toMatch(/Advertisement/);
    });
  }

  it('uses Readability (not the fallback) on all five well-formed fixtures', () => {
    for (const { file, url } of FIXTURES) {
      const document = loadFixtureDocument(file, url);
      const doc = extractArticle(document, url, 'id');
      expect(doc.usedFallbackExtraction, `${file} unexpectedly used the fallback extractor`).toBe(false);
    }
  });

  it('resolves relative image src to an absolute URL', () => {
    const document = loadFixtureDocument('bbc.html', 'https://www.bbc.com/future/article/hidden-benefits-of-doing-nothing');
    const doc = extractArticle(document, 'https://www.bbc.com/future/article/hidden-benefits-of-doing-nothing', 'id');
    const img = doc.blocks.find((b): b is Extract<Block, { kind: 'img' }> => b.kind === 'img');
    expect(img).toBeDefined();
    expect(img!.src.startsWith('https://www.bbc.com/')).toBe(true);
  });

  it('picks the largest srcset candidate when an img has no src at all', () => {
    const url = 'https://www.bbc.com/future/article/hidden-benefits-of-doing-nothing';
    const doc = extractArticle(loadFixtureDocument('bbc.html', url), url, 'id');
    const srcs = imageBlocks(doc.blocks).map((b) => b.src);
    expect(srcs).toContain('https://www.bbc.com/images/w1600.jpg');
    expect(srcs).not.toContain('https://www.bbc.com/images/w800.jpg');
  });

  it('lifts an image out of a paragraph and keeps the paragraph text, image first', () => {
    const url = 'https://www.bbc.com/future/article/hidden-benefits-of-doing-nothing';
    const doc = extractArticle(loadFixtureDocument('bbc.html', url), url, 'id');
    const imgIndex = doc.blocks.findIndex(
      (b) => b.kind === 'img' && b.src === 'https://www.bbc.com/images/inline-chart.png'
    );
    expect(imgIndex).toBeGreaterThanOrEqual(0);

    const img = doc.blocks[imgIndex] as Extract<Block, { kind: 'img' }>;
    expect(img.inline).toBe(true);
    expect(img.width).toBe(800);
    expect(img.height).toBe(400);

    // The <img> precedes the text inside the <p>, so its row must too.
    const next = doc.blocks[imgIndex + 1];
    expect(next?.kind).toBe('p');
    expect(allText([next!])).toMatch(/Activity peaks in the quiet hours/);
  });

  it('keeps an in-table image, absolutized, in the sanitized table html', () => {
    const url = 'https://www.bbc.com/future/article/hidden-benefits-of-doing-nothing';
    const doc = extractArticle(loadFixtureDocument('bbc.html', url), url, 'id');
    const table = doc.blocks.find((b): b is Block & { kind: 'table' } => b.kind === 'table');
    expect(table).toBeDefined();
    expect(table!.html).toContain('src="https://www.bbc.com/images/walk-icon.png"');
    expect(table!.html).not.toContain('class=');
  });

  it('extracts images from a <picture>/<source srcset> with no usable img src', () => {
    const url = 'https://www.astralcodexten.com/p/nicholas-decker-in-hell';
    const doc = extractArticle(loadFixtureDocument('substack.html', url), url, 'id');
    const images = imageBlocks(doc.blocks);
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) expect(img.src).toMatch(/^https?:\/\//);
  });

  it('never emits an image block with an unsafe or relative src', () => {
    for (const { file, url } of FIXTURES) {
      const doc = extractArticle(loadFixtureDocument(file, url), url, 'id');
      for (const img of imageBlocks(doc.blocks)) {
        expect(img.src, `${file} produced a non-http(s) image src`).toMatch(/^https?:\/\//);
      }
    }
  });

  describe('lazy-loading and widget image patterns', () => {
    const url = 'https://example.com/post/lazy';
    const load = (): ReturnType<typeof extractArticle> =>
      extractArticle(loadFixtureDocument('lazy-images.html', url), url, 'id');

    it('prefers data-src over a placeholder parked in src', () => {
      const srcs = imageBlocks(load().blocks).map((b) => b.src);
      expect(srcs).toContain('https://example.com/real/first.jpg');
      expect(srcs).not.toContain('https://example.com/assets/placeholder.png');
    });

    it('falls through a rejected data: placeholder to the data-srcset candidates', () => {
      const srcs = imageBlocks(load().blocks).map((b) => b.src);
      expect(srcs).toContain('https://example.com/real/second-1600.webp');
      expect(srcs).not.toContain('https://example.com/real/second-800.webp');
    });

    it('keeps a srcset URL that contains commas intact', () => {
      const srcs = imageBlocks(load().blocks).map((b) => b.src);
      expect(srcs).toContain(
        'https://res.cloudinary.com/demo/image/upload/w_900,h_600,c_fill/pic.jpg'
      );
      // The old comma-split produced this fragment, resolved against the page URL.
      expect(srcs).not.toContain('https://example.com/post/c_fill/pic.jpg');
    });

    it('keeps a raster data: image but never an svg one', () => {
      const srcs = imageBlocks(load().blocks).map((b) => b.src);
      expect(srcs.some((src) => src.startsWith('data:image/png;base64,'))).toBe(true);
      expect(srcs.some((src) => src.includes('svg'))).toBe(false);
    });

    it('recovers images from a custom element that carries the URL itself', () => {
      const srcs = imageBlocks(load().blocks).map((b) => b.src);
      for (const slide of ['one', 'two', 'three']) {
        expect(srcs).toContain(`https://example.com/widget/slide-${slide}.webp`);
      }
    });

    it('recovers a text-less gallery that Readability would delete, deduplicated', () => {
      const doc = load();
      expect(doc.usedFallbackExtraction).toBe(false); // the rescue must work on the Readability path
      const srcs = imageBlocks(doc.blocks).map((b) => b.src);
      for (const name of ['a', 'b', 'c']) {
        expect(srcs).toContain(`https://example.com/gallery/${name}.jpg`);
      }
      // /gallery/a.jpg appears twice in the fixture; one row is enough.
      expect(srcs.filter((src) => src.endsWith('/gallery/a.jpg'))).toHaveLength(1);
    });

    it('leaves the prose of a paragraph that also holds an image', () => {
      const text = allText(load().blocks);
      expect(text).toMatch(/Lazy loaders park a grey placeholder/);
      expect(text).toMatch(/closing paragraph/);
    });
  });

  it('captures a figcaption as translatable caption sentences on an image block', () => {
    const document = loadFixtureDocument('bbc.html', 'https://www.bbc.com/future/article/hidden-benefits-of-doing-nothing');
    const doc = extractArticle(document, 'https://www.bbc.com/future/article/hidden-benefits-of-doing-nothing', 'id');
    const img = doc.blocks.find((b): b is Extract<Block, { kind: 'img' }> => b.kind === 'img');
    expect(img?.caption?.[0]?.text).toMatch(/idle moments/i);
  });

  it('extracts a sanitized code block from the Medium fixture, with the language class attribute stripped', () => {
    const document = loadFixtureDocument('medium.html', 'https://medium.com/free-code-camp/how-i-cut-my-deploy-time-in-half');
    const doc = extractArticle(document, 'https://medium.com/free-code-camp/how-i-cut-my-deploy-time-in-half', 'id');
    const code = doc.blocks.find((b): b is Block & { kind: 'code' } => b.kind === 'code');
    expect(code).toBeDefined();
    expect(code!.html).toContain('shard');
    expect(code!.html).not.toContain('class=');
    expect(code!.html).not.toContain('<script');
  });

  it('does not translate code/table block content (blocks stay as opaque html)', () => {
    const document = loadFixtureDocument('medium.html', 'https://medium.com/free-code-camp/how-i-cut-my-deploy-time-in-half');
    const doc = extractArticle(document, 'https://medium.com/free-code-camp/how-i-cut-my-deploy-time-in-half', 'id');
    const code = doc.blocks.find((b) => b.kind === 'code');
    expect(code && 'sentences' in code).toBe(false);
  });

  it('splits paragraph text into multiple sentence-level entries', () => {
    const document = loadFixtureDocument('bbc.html', 'https://www.bbc.com/future/article/hidden-benefits-of-doing-nothing');
    const doc = extractArticle(document, 'https://www.bbc.com/future/article/hidden-benefits-of-doing-nothing', 'id');
    const firstParagraph = doc.blocks.find((b) => b.kind === 'p' && b.sentences.length > 1);
    expect(firstParagraph).toBeDefined();
  });

  it('falls back to the heuristic extractor and flags usedFallbackExtraction for a near-empty document', () => {
    const html = '<html><body><div id="app"></div><script>renderApp()</script></body></html>';
    const dom = new JSDOM(html, { url: 'https://example.com/empty' });
    const doc = extractArticle(dom.window.document, 'https://example.com/empty', 'id');
    expect(doc.usedFallbackExtraction).toBe(true);
  });

  describe('list numbering (ordered/unordered)', () => {
    function extractLists(bodyHtml: string): Block[] {
      const html = `<html><body><article>
        <p>${'Filler prose long enough for Readability to treat this as real article content. '.repeat(4)}</p>
        ${bodyHtml}
      </article></body></html>`;
      const dom = new JSDOM(html, { url: 'https://example.com/list-test' });
      const doc = extractArticle(dom.window.document, 'https://example.com/list-test', 'id');
      expect(doc.usedFallbackExtraction).toBe(false);
      return doc.blocks.filter((b) => b.kind === 'li');
    }

    it('numbers <ol> items starting at 1 and marks them ordered', () => {
      const lis = extractLists('<ol><li>First step.</li><li>Second step.</li><li>Third step.</li>');
      expect(lis.map((b) => ('ordered' in b ? b.ordered : undefined))).toEqual([true, true, true]);
      expect(lis.map((b) => ('listNumber' in b ? b.listNumber : undefined))).toEqual([1, 2, 3]);
    });

    it('leaves <ul> items unordered, with no listNumber', () => {
      const lis = extractLists('<ul><li>Bullet one.</li><li>Bullet two.</li>');
      expect(lis.map((b) => ('ordered' in b ? b.ordered : undefined))).toEqual([false, false]);
      expect(lis.every((b) => !('listNumber' in b) || b.listNumber === undefined)).toBe(true);
    });

    it('honors an <ol start> attribute', () => {
      const lis = extractLists('<ol start="5"><li>Fifth.</li><li>Sixth.</li>');
      expect(lis.map((b) => ('listNumber' in b ? b.listNumber : undefined))).toEqual([5, 6]);
    });

    it('honors a per-item value= override', () => {
      const lis = extractLists('<ol><li>One.</li><li value="10">Ten.</li><li>Eleven.</li>');
      expect(lis.map((b) => ('listNumber' in b ? b.listNumber : undefined))).toEqual([1, 10, 11]);
    });
  });

  it('extracts div-soup content with no semantic tags via the leaf-text-node heuristic', () => {
    const html = `<html><body><main>
      <div>Title Only Div</div>
      <div>This is a plain paragraph with no semantic wrapper tag at all, written long enough to be readable.</div>
      <div>And here is a second such paragraph, also long enough to count as real content for the extractor.</div>
    </main></body></html>`;
    const dom = new JSDOM(html, { url: 'https://example.com/div-soup' });
    const doc = extractArticle(dom.window.document, 'https://example.com/div-soup', 'id');
    const text = allText(doc.blocks);
    expect(text).toMatch(/plain paragraph/);
  });
});
