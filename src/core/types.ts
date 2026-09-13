// Core data model. This is the pivot of the whole system: the content
// script produces an ArticleDoc, the reader renders it, the translation
// layer fills in Sentence.translation, and vocab entries reference back
// into it. Nothing here may hold raw site HTML - see InlineRun below.

/** Whitelisted inline formatting tags. Anything else collapses to plain text. */
export type InlineTag = 'a' | 'b' | 'i' | 'code';

/**
 * Describes one span of formatting over a Sentence's plain `text`, by
 * character offset (like a mini AST flattened to ranges). This - not raw
 * HTML - is how markup crosses from the content script's world into the
 * extension's privileged pages. See core/inline.ts for the (de)serializer
 * and its XSS test fixture.
 */
export interface InlineRun {
  start: number;
  end: number;
  tag: InlineTag;
  /** Only meaningful when tag === 'a'. Must pass isSafeHref() before use. */
  href?: string;
}

export interface Sentence {
  id: string;
  text: string;
  runs: InlineRun[];
  /** Filled in later by the translation pipeline; absent until translated. */
  translation?: string;
  /** BCP-47-ish code as reported by the translation provider, if any. */
  detectedLang?: string;
}

export type TextBlockKind = 'p' | 'h1' | 'h2' | 'h3' | 'li' | 'quote';

export interface TextBlock {
  kind: TextBlockKind;
  id: string;
  sentences: Sentence[];
}

export interface ImageBlock {
  kind: 'img';
  id: string;
  src: string;
  alt?: string;
  /** Declared HTML width/height, when the source page stated them. Rendered as
   * attributes so the browser can reserve the right aspect ratio and a lazy
   * image landing late doesn't shift the two columns out of alignment. */
  width?: number;
  height?: number;
  /**
   * True when this image was lifted out of a text element (`<p><img></p>`, a
   * list item, an inline icon) rather than being a standalone/figure image.
   * Rendered left-aligned at its natural size instead of centered, so a 16px
   * icon stays a 16px icon rather than becoming a full-width banner.
   */
  inline?: boolean;
  /** Caption text is translated like any other sentence; the image itself is not. */
  caption?: Sentence[];
}

export interface OpaqueBlock {
  kind: 'code' | 'table';
  id: string;
  /**
   * Sanitized-on-render HTML fragment (whitelist tags only - see
   * core/inline.ts sanitizeOpaqueHtml). Spans both reader columns and is
   * never sent to the translation provider.
   */
  html: string;
}

export type Block = TextBlock | ImageBlock | OpaqueBlock;

/**
 * Explicit type guard for narrowing Block -> TextBlock. TS's own control-flow
 * narrowing on `block.kind === 'code' || block.kind === 'table'` inside a
 * `continue`-guarded loop doesn't reliably exclude OpaqueBlock in practice
 * (observed with this compiler/config), so callers that need `.sentences`
 * after ruling out 'img'/'code'/'table' should use this instead of relying
 * on narrowing.
 */
export function isTextBlock(block: Block): block is TextBlock {
  return (
    block.kind === 'p' ||
    block.kind === 'h1' ||
    block.kind === 'h2' ||
    block.kind === 'h3' ||
    block.kind === 'li' ||
    block.kind === 'quote'
  );
}

export interface ArticleDoc {
  id: string;
  url: string;
  title: string;
  byline?: string;
  siteName?: string;
  /** Detected/declared source language, e.g. from <html lang>. Reader still lets user override. */
  srcLang?: string;
  capturedAt: number;
  blocks: Block[];
  /** True when Readability failed and the heuristic fallback extractor was used. */
  usedFallbackExtraction?: boolean;
}

export interface VocabEntry {
  id: string;
  term: string;
  translation: string;
  /** The sentence the term was selected from, original language. */
  contextText: string;
  /** Character offsets of `term` within contextText, for <b> wrapping on export. */
  contextStart: number;
  contextEnd: number;
  sourceUrl: string;
  sourceTitle: string;
  createdAt: number;
  tags: string[];
}

export interface Settings {
  schemaVersion: number;
  targetLang: string;
  fontSizePx: number;
  /** Domains where translation/reader is refused outright (privacy - R10). */
  blockedDomains: string[];
  /** Whether the first-run privacy notice has been acknowledged. */
  privacyNoticeAcknowledged: boolean;
  cacheFolderConfigured: boolean;
}

export const SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SCHEMA_VERSION,
  targetLang: 'vi',
  fontSizePx: 17,
  blockedDomains: ['mail.google.com', '*.atlassian.net', 'localhost'],
  privacyNoticeAcknowledged: false,
  cacheFolderConfigured: false,
};
