// Sentence segmentation: Intl.Segmenter does the heavy lifting, but its
// Unicode sentence-break rules routinely split after abbreviations
// ("Mr. Smith", "the U.S. is", "e.g. apples") and sometimes after other
// mid-sentence punctuation. A wrong split here means the reader shows a
// fragment as its own row, paired against a translation that covers a
// different span of text - misalignment - and it means we send more,
// smaller translation requests than necessary. This module segments, then
// runs a merge pass to undo the splits that are almost certainly wrong.

/** Common abbreviations (lowercased, without trailing period) that must not end a sentence on their own. */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sr', 'jr', 'st', 'ave', 'blvd', 'rd',
  'vs', 'etc', 'approx', 'apt', 'no', 'fig', 'vol', 'pp', 'para',
  'inc', 'ltd', 'co', 'corp', 'gov', 'dept', 'univ', 'assn', 'bros',
  'e.g', 'i.e', 'u.s', 'u.k', 'u.n', 'u.s.a', 'ph.d', 'a.m', 'p.m', 'a.d', 'b.c',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
]);

/** Matches one "word.word.word" abbreviation-like token (e.g. "U.S", "e.g", "Ph.D") right before the cursor. */
const TRAILING_TOKEN_RE = /([A-Za-z](?:\.[A-Za-z]+)*|[A-Za-z]+)\.?$/;

function endsWithAbbreviation(text: string): boolean {
  const trimmed = text.trimEnd();
  const withoutFinalDot = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  const match = TRAILING_TOKEN_RE.exec(withoutFinalDot);
  if (!match) return false;
  const token = match[1]?.toLowerCase();
  if (!token) return false;
  // Single capital letter (initial, e.g. "J. K. Rowling") - always an abbreviation.
  if (/^[a-z]$/.test(token) && /[A-Z]/.test(match[1]![0]!)) return true;
  return ABBREVIATIONS.has(token);
}

function endsWithEllipsis(text: string): boolean {
  return /(\.\.\.|…)\s*$/.test(text);
}

function endsWithDecimalPoint(text: string): boolean {
  return /\d\.\s*$/.test(text.trimEnd() + ' ');
}

function startsWithLowercase(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.length > 0 && /^\p{Ll}/u.test(trimmed);
}

function startsWithDigit(text: string): boolean {
  return /^\s*\d/.test(text);
}

/** Decides whether `next` is very likely a continuation of `prev` rather than a new sentence. */
function shouldMerge(prev: string, next: string): boolean {
  if (next.trim().length === 0) return true; // pure whitespace/fragment - always reattach
  if (endsWithAbbreviation(prev)) return true;
  if (endsWithDecimalPoint(prev) && startsWithDigit(next)) return true;
  if (endsWithEllipsis(prev) && startsWithLowercase(next)) return true;
  if (startsWithLowercase(next)) return true;
  return false;
}

/**
 * Splits `text` into sentence strings, using Intl.Segmenter plus a merge
 * pass for abbreviations / decimals / ellipses / lowercase continuations.
 * `locale` defaults to a generic setting since the source language may be
 * unknown ('auto') at extraction time.
 */
export function splitSentences(text: string, locale = 'en'): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return [];

  const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  const raw = Array.from(segmenter.segment(normalized), (s) => s.segment);

  const merged: string[] = [];
  for (const piece of raw) {
    const last = merged[merged.length - 1];
    if (last !== undefined && shouldMerge(last, piece)) {
      merged[merged.length - 1] = last + piece;
    } else {
      merged.push(piece);
    }
  }

  return merged.map((s) => s.trim()).filter((s) => s.length > 0);
}

export interface OffsetSentence {
  text: string;
  /** Character offset range within the exact `text` passed to splitSentencesWithOffsets - NOT re-normalized. */
  start: number;
  end: number;
}

/**
 * Same segmentation + merge pass as splitSentences, but returns offsets
 * into the *original* input string instead of normalizing whitespace
 * first. content/extract.ts uses this to re-slice a block's InlineRun[]
 * (which are offset against that same original text) per sentence -
 * normalizing whitespace here would desync those offsets.
 */
export function splitSentencesWithOffsets(text: string, locale = 'en'): OffsetSentence[] {
  if (text.trim().length === 0) return [];

  const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  const raw = Array.from(segmenter.segment(text), (s) => ({
    text: s.segment,
    start: s.index,
    end: s.index + s.segment.length,
  }));

  const merged: OffsetSentence[] = [];
  for (const piece of raw) {
    const last = merged[merged.length - 1];
    if (last !== undefined && shouldMerge(last.text, piece.text)) {
      last.text += piece.text;
      last.end = piece.end;
    } else {
      merged.push({ ...piece });
    }
  }

  const trimmed: OffsetSentence[] = [];
  for (const s of merged) {
    const leadingWs = s.text.length - s.text.trimStart().length;
    const trimmedText = s.text.trim();
    if (trimmedText.length === 0) continue;
    const start = s.start + leadingWs;
    trimmed.push({ text: trimmedText, start, end: start + trimmedText.length });
  }
  return trimmed;
}
