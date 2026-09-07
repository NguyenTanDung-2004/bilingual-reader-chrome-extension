import { describe, expect, it } from 'vitest';
import {
  buildInlineFragment,
  extractInline,
  isSafeHref,
  resolveSafeHref,
  sanitizeOpaqueHtml,
} from './inline';
import type { InlineRun } from './types';

function html(node: Node): string {
  const div = document.createElement('div');
  div.appendChild(node);
  return div.innerHTML;
}

describe('extractInline', () => {
  it('flattens text and records whitelisted runs with correct offsets', () => {
    const el = document.createElement('p');
    el.innerHTML = 'Hello <b>bold</b> and <i>italic</i> and <code>code</code>.';
    const { text, runs } = extractInline(el, 'https://example.com/');
    expect(text).toBe('Hello bold and italic and code.');
    expect(runs).toEqual([
      { start: 6, end: 10, tag: 'b' },
      { start: 15, end: 21, tag: 'i' },
      { start: 26, end: 30, tag: 'code' },
    ]);
  });

  it('unwraps unknown tags but keeps their text', () => {
    const el = document.createElement('p');
    el.innerHTML = 'Hello <span class="tracker">world</span>.';
    const { text, runs } = extractInline(el, 'https://example.com/');
    expect(text).toBe('Hello world.');
    expect(runs).toEqual([]);
  });

  it('drops <script> content entirely', () => {
    const el = document.createElement('p');
    el.innerHTML = 'Before<script>document.title="pwned"</script>After';
    const { text } = extractInline(el, 'https://example.com/');
    expect(text).toBe('BeforeAfter');
  });

  it('records a safe absolute href on an <a> run', () => {
    const el = document.createElement('p');
    el.innerHTML = 'See <a href="https://example.org/page">this</a>.';
    const { runs } = extractInline(el, 'https://example.com/');
    expect(runs).toEqual([{ start: 4, end: 8, tag: 'a', href: 'https://example.org/page' }]);
  });

  it('resolves a relative href against baseUrl', () => {
    const el = document.createElement('p');
    el.innerHTML = '<a href="/other">link</a>';
    const { runs } = extractInline(el, 'https://example.com/articles/1');
    expect(runs).toEqual([{ start: 0, end: 4, tag: 'a', href: 'https://example.com/other' }]);
  });

  it('drops a javascript: href and does not record any run', () => {
    const el = document.createElement('p');
    el.innerHTML = '<a href="javascript:alert(1)">click me</a>';
    const { text, runs } = extractInline(el, 'https://example.com/');
    expect(text).toBe('click me');
    expect(runs).toEqual([]);
  });
});

describe('isSafeHref / resolveSafeHref', () => {
  it('accepts http/https/mailto', () => {
    expect(isSafeHref('https://example.com/')).toBe(true);
    expect(isSafeHref('http://example.com/')).toBe(true);
    expect(isSafeHref('mailto:a@b.com')).toBe(true);
  });

  it('rejects javascript:, data:, and vbscript: protocols', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false);
  });

  it('resolveSafeHref returns undefined for unsafe protocols even after resolution', () => {
    expect(resolveSafeHref('javascript:alert(1)', 'https://example.com/')).toBeUndefined();
  });
});

describe('buildInlineFragment (render side, defense in depth)', () => {
  it('renders plain text with no runs', () => {
    const frag = buildInlineFragment('hello world', []);
    expect(html(frag)).toBe('hello world');
  });

  it('renders whitelisted tags from stored runs', () => {
    const runs: InlineRun[] = [
      { start: 0, end: 5, tag: 'b' },
      { start: 6, end: 11, tag: 'i' },
    ];
    const frag = buildInlineFragment('hello world', runs);
    expect(html(frag)).toBe('<b>hello</b> <i>world</i>');
  });

  it('never sets href from a run carrying a javascript: URL, even though the type allows any string', () => {
    // Simulates a tampered/corrupted on-disk cache entry: extractInline
    // would never produce this, but render must not trust stored data blindly.
    const runs: InlineRun[] = [{ start: 0, end: 4, tag: 'a', href: 'javascript:alert(document.cookie)' }];
    const frag = buildInlineFragment('evil', runs);
    const rendered = html(frag);
    expect(rendered).not.toContain('javascript:');
    expect(rendered).toBe('<a>evil</a>');
  });

  it('drops a run with out-of-range offsets instead of throwing', () => {
    const runs: InlineRun[] = [{ start: -5, end: 999, tag: 'b' }];
    expect(() => buildInlineFragment('short', runs)).not.toThrow();
    expect(html(buildInlineFragment('short', runs))).toBe('short');
  });

  it('drops a run with an unknown tag value instead of throwing', () => {
    const runs = [{ start: 0, end: 4, tag: 'script' }] as unknown as InlineRun[];
    expect(html(buildInlineFragment('evil', runs))).toBe('evil');
  });
});

describe('sanitizeOpaqueHtml', () => {
  it('keeps whitelisted table structure and strips everything else', () => {
    const dirty = '<table><tr><td colspan="2" onclick="alert(1)">Cell</td></tr></table>';
    const clean = sanitizeOpaqueHtml(dirty);
    expect(clean).toBe('<table><tbody><tr><td colspan="2">Cell</td></tr></tbody></table>');
  });

  it('drops <script> entirely, including its text content', () => {
    const dirty = '<pre><code>safe<script>alert(1)</script>code</code></pre>';
    const clean = sanitizeOpaqueHtml(dirty);
    expect(clean).toBe('<pre><code>safecode</code></pre>');
    expect(clean).not.toContain('script');
    expect(clean).not.toContain('alert');
  });

  it('neutralizes <img onerror=...> by dropping the img tag but keeping sibling text', () => {
    const dirty = '<pre><code>before<img src="x" onerror="alert(1)">after</code></pre>';
    const clean = sanitizeOpaqueHtml(dirty);
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('<img');
    expect(clean).toContain('before');
    expect(clean).toContain('after');
  });

  it('unwraps a nested disallowed wrapper but keeps its sanitized descendants', () => {
    const dirty = '<pre><code><div class="line"><span>kept text</span></div></code></pre>';
    const clean = sanitizeOpaqueHtml(dirty);
    expect(clean).toBe('<pre><code>kept text</code></pre>');
  });

  it('removes a nested script hidden inside an unwrapped wrapper (bottom-up sanitization)', () => {
    const dirty = '<table><tr><td><div>ok<script>alert(1)</script></div></td></tr></table>';
    const clean = sanitizeOpaqueHtml(dirty);
    expect(clean).not.toContain('script');
    expect(clean).not.toContain('alert');
    expect(clean).toContain('ok');
  });

  it('strips a javascript: href by dropping the disallowed <a> wrapper entirely', () => {
    const dirty = '<pre><code><a href="javascript:alert(1)">link text</a></code></pre>';
    const clean = sanitizeOpaqueHtml(dirty);
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('<a');
    expect(clean).toContain('link text');
  });
});
