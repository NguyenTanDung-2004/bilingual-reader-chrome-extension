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
// onerror=>, javascript: href).

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

/** Elements whose text/markup must never be pulled into extracted plain text. */
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
    if (INLINE_BLOCKED_TAGS.has(el.tagName)) return;

    const start = text.length;
    for (const child of Array.from(el.childNodes)) visit(child);
    const end = text.length;
    if (end <= start) return;

    const tag = INLINE_TAG_MAP[el.tagName];
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

/** Structural tags allowed to survive in a 'code'/'table' Block's html. No 'a', no 'img', no styling hooks. */
const OPAQUE_ALLOWED_TAGS = new Set([
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
};

function cleanOpaqueSubtree(node: Element): void {
  const children = Array.from(node.childNodes);
  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) {
      node.removeChild(child); // comments, processing instructions, etc.
      continue;
    }
    const el = child as Element;
    if (OPAQUE_HARD_DROP_TAGS.has(el.tagName)) {
      node.removeChild(el);
      continue;
    }
    // Recurse first so any disallowed descendant (e.g. a <div> hiding a
    // nested <script>) is fully sanitized *before* it can be unwrapped and
    // promoted up to this level.
    cleanOpaqueSubtree(el);

    if (!OPAQUE_ALLOWED_TAGS.has(el.tagName)) {
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      }
      continue;
    }

    const allowedAttrs = OPAQUE_ATTR_ALLOWLIST[el.tagName];
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
 * for the reader to set via innerHTML.
 */
export function sanitizeOpaqueHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = doc.getElementById('root');
  if (!root) return '';
  cleanOpaqueSubtree(root);
  return root.innerHTML;
}
