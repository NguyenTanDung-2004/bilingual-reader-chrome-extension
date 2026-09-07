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
