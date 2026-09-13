// Inline markup: text + InlineRun[] <-> DOM, and a separate sanitizer for
// the opaque 'code'/'table' block HTML. This file is the security boundary
// described in the spec: the reader page runs at the extension's origin
// with elevated privileges (storage, host permissions), so anything that
// lets arbitrary site HTML/attributes reach its DOM is a privilege
// escalation, not "just" an XSS bug on some random site. Every function
// here either (a) builds DOM nodes directly from a whitelist, never via
// innerHTML with untrusted input, or (b) parses untrusted HTML in a
// detached DOMParser document and walks/strips it before it is ever
// serialized or attached anywhere live.
//
// See inline.test.ts for the required XSS fixtures (<script>, <img
// onerror=>, javascript: href, javascript:/data: image src).

import type { InlineRun, InlineTag } from './types';

const SAFE_HREF_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** True if `href` (already absolute) uses a whitelisted protocol. Re-checked at render time - never trust a stored InlineRun blindly. */
export function isSafeHref(href: string): boolean {
  try {
    const url = new URL(href);
    return SAFE_HREF_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

/** Resolves a possibly-relative href against the page's URL and returns it only if the result is safe. */
export function resolveSafeHref(href: string, baseUrl: string): string | undefined {
  try {
    const resolved = new URL(href, baseUrl).toString();
    return isSafeHref(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** Image sources are stricter than hrefs: no `mailto:`, and no scheme beyond these plus the `data:` subset below. */
const SAFE_IMAGE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Raster `data:` images are allowed - a chart exported from a notebook, an
 * inline diagram - but `image/svg+xml` is not: an SVG is a document that can
 * carry <script>/onload, so it is a script-execution vector rather than a
 * picture. Base64 is required; a plain-text raster payload is not a real
 * thing, and demanding the encoding keeps anything cleverer out.
 */
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp)\s*;\s*base64\s*,[A-Za-z0-9+/=\s]+$/i;

/** An ArticleDoc is persisted to the fs-cache, so an inline image cannot be unbounded. */
const MAX_DATA_IMAGE_CHARS = 2_000_000;

/** True if `src` (already absolute) is a fetchable, non-scripting image URL. Re-checked at render time - an ImageBlock read back from on-disk cache is not trusted. */
export function isSafeImageSrc(src: string): boolean {
  if (/^data:/i.test(src)) {
    return src.length <= MAX_DATA_IMAGE_CHARS && SAFE_DATA_IMAGE_RE.test(src);
  }
  try {
    return SAFE_IMAGE_PROTOCOLS.has(new URL(src).protocol);
  } catch {
    return false;
  }
}

/** Resolves a possibly-relative image src against the page's URL and returns it only if the result is safe. */
export function resolveSafeImageSrc(src: string, baseUrl: string): string | undefined {
  if (!src) return undefined;
  try {
    const resolved = new URL(src, baseUrl).toString();
    return isSafeImageSrc(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

const INLINE_TAG_MAP: Record<string, InlineTag> = {
  A: 'a',
  B: 'b',
  STRONG: 'b',
  I: 'i',
  EM: 'i',
  CODE: 'code',
  KBD: 'code',
  SAMP: 'code',
};

/**
 * Elements whose text/markup must never be pulled into extracted plain text.
 * Matched against an upper-cased tagName: elements in the SVG namespace report
 * a *lowercase* tagName ('svg', 'title', 'text'), so comparing raw tagName
 * against this set never matched them and SVG label text leaked into the
 * extracted prose.
 */
const INLINE_BLOCKED_TAGS = new Set([
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
 * Walks a *live source-page* DOM node and flattens it to plain text plus a
 * list of InlineRun spans for whitelisted formatting. Called by
 * content/extract.ts, which has the only legitimate reason to read
 * arbitrary site DOM. `baseUrl` is used to resolve relative hrefs.
 */
export function extractInline(root: Node, baseUrl: string): { text: string; runs: InlineRun[] } {
  const runs: InlineRun[] = [];
  let text = '';

  function visit(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tagName = el.tagName.toUpperCase();
    if (INLINE_BLOCKED_TAGS.has(tagName)) return;

    const start = text.length;
    for (const child of Array.from(el.childNodes)) visit(child);
    const end = text.length;
    if (end <= start) return;

    const tag = INLINE_TAG_MAP[tagName];
    if (!tag) return; // unwrap: text already captured above, no run recorded

    if (tag === 'a') {
      const rawHref = el.getAttribute('href');
      const safeHref = rawHref ? resolveSafeHref(rawHref, baseUrl) : undefined;
      if (safeHref) runs.push({ start, end, tag, href: safeHref });
      // No safe href: drop the anchor formatting entirely rather than render a dead/dangerous link.
      return;
    }
    runs.push({ start, end, tag });
  }

  visit(root);
  return { text, runs };
}

const RENDER_TAG_ORDER: InlineTag[] = ['a', 'b', 'i', 'code'];

/**
 * Reconstructs DOM nodes for `text` + `runs`, built entirely from
 * createElement/createTextNode/setAttribute against a fixed whitelist -
 * never via innerHTML. Malformed runs (out-of-range offsets, unsafe hrefs,
 * unknown tags) are silently dropped rather than throwing, since this may
 * render data read back from on-disk cache that could have been altered
 * outside the extension.
 */
export function buildInlineFragment(text: string, runs: InlineRun[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const validRuns = runs.filter(
    (r) =>
      Number.isInteger(r.start) &&
      Number.isInteger(r.end) &&
      r.start >= 0 &&
      r.end <= text.length &&
      r.start < r.end &&
      RENDER_TAG_ORDER.includes(r.tag)
  );

  const boundaries = new Set<number>([0, text.length]);
  for (const r of validRuns) {
    boundaries.add(r.start);
    boundaries.add(r.end);
  }
  const points = Array.from(boundaries).sort((a, b) => a - b);

  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (start >= end) continue;

    const active = validRuns.filter((r) => r.start <= start && r.end >= end);
    let node: Node = document.createTextNode(text.slice(start, end));

    for (const tag of RENDER_TAG_ORDER) {
      const run = active.find((r) => r.tag === tag);
      if (!run) continue;
      const el = document.createElement(tag);
      if (tag === 'a' && run.href && isSafeHref(run.href)) {
        el.setAttribute('href', run.href);
        el.setAttribute('rel', 'noopener noreferrer');
        el.setAttribute('target', '_blank');
      }
      el.appendChild(node);
      node = el;
    }
    frag.appendChild(node);
  }

  return frag;
}

// --- Opaque block (code/table) sanitizer -----------------------------------

/**
 * Structural tags allowed to survive in a 'code'/'table' Block's html. No 'a',
 * no styling hooks. 'IMG' is allowed (infobox icons, in-table diagrams) but
 * only ever with the four attributes in OPAQUE_ATTR_ALLOWLIST and an
 * http(s) src - see cleanOpaqueSubtree.
 */
const OPAQUE_ALLOWED_TAGS = new Set([
  'IMG',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TD',
  'TH',
  'CAPTION',
  'COLGROUP',
  'COL',
  'PRE',
  'CODE',
  'BR',
]);

/** Tags dropped along with their entire subtree (never unwrapped - their content isn't meaningful prose anyway). */
const OPAQUE_HARD_DROP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'SVG',
  'NOSCRIPT',
  'TEMPLATE',
  'LINK',
  'META',
  'BASE',
]);

const OPAQUE_ATTR_ALLOWLIST: Record<string, Set<string>> = {
  TD: new Set(['colspan', 'rowspan']),
  TH: new Set(['colspan', 'rowspan']),
  // No 'srcset'/'sizes' (a second, unvalidated URL channel), no 'style',
  // no 'class', and crucially no event handlers - the generic attribute
  // sweep below drops everything not listed here, onerror included.
  IMG: new Set(['src', 'alt', 'width', 'height']),
};

/** Normalizes a declared width/height attribute to a positive integer, or removes it. */
function normalizeSizeAttr(el: Element, name: 'width' | 'height'): void {
  const raw = el.getAttribute(name);
  if (raw === null) return;
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) el.setAttribute(name, String(n));
  else el.removeAttribute(name);
}

/**
 * Rewrites an allowed <img> in place: absolutizes its src against `baseUrl`
 * (when the caller supplied one) and validates the protocol. Returns false
 * when the image cannot be made safe, in which case the caller drops the
 * whole element - an <img> without a usable src is meaningless anyway.
 *
 * `baseUrl` is intentionally optional: extraction passes the source page's
 * URL, but render-time re-sanitization does not, so a relative src that
 * somehow reached the cache is dropped rather than resolved against the
 * extension's own origin.
 */
function cleanOpaqueImage(el: Element, baseUrl?: string): boolean {
  const raw = (el.getAttribute('src') ?? '').trim();
  if (!raw) return false;
  const safe = baseUrl ? resolveSafeImageSrc(raw, baseUrl) : isSafeImageSrc(raw) ? raw : undefined;
  if (!safe) return false;
  el.setAttribute('src', safe);
  normalizeSizeAttr(el, 'width');
  normalizeSizeAttr(el, 'height');
  return true;
}

function cleanOpaqueSubtree(node: Element, baseUrl?: string): void {
  const children = Array.from(node.childNodes);
  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) {
      node.removeChild(child); // comments, processing instructions, etc.
      continue;
    }
    const el = child as Element;
    const tagName = el.tagName.toUpperCase();
    if (OPAQUE_HARD_DROP_TAGS.has(tagName)) {
      node.removeChild(el);
      continue;
    }
    // Recurse first so any disallowed descendant (e.g. a <div> hiding a
    // nested <script>) is fully sanitized *before* it can be unwrapped and
    // promoted up to this level.
    cleanOpaqueSubtree(el, baseUrl);

    if (!OPAQUE_ALLOWED_TAGS.has(tagName)) {
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      }
      continue;
    }

    // Must run before the attribute sweep below, which is what strips
    // onerror/onload/style/srcset - it would also wipe the src we need to read.
    if (tagName === 'IMG' && !cleanOpaqueImage(el, baseUrl)) {
      node.removeChild(el);
      continue;
    }

    const allowedAttrs = OPAQUE_ATTR_ALLOWLIST[tagName];
    for (const attr of Array.from(el.attributes)) {
      if (!allowedAttrs?.has(attr.name)) el.removeAttribute(attr.name);
    }
  }
}

/**
 * Sanitizes an untrusted HTML fragment (destined for an OpaqueBlock's
 * `html`) down to the structural-only whitelist above. Parses via
 * DOMParser into a detached document (never executes scripts or loads
 * resources), cleans it, and returns a serialized string that is then safe
 * for the reader to set via innerHTML. `baseUrl` (extraction time only)
 * lets relative <img> sources be absolutized; without it they are dropped.
 */
export function sanitizeOpaqueHtml(html: string, baseUrl?: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = doc.getElementById('root');
  if (!root) return '';
  cleanOpaqueSubtree(root, baseUrl);
  return root.innerHTML;
}
