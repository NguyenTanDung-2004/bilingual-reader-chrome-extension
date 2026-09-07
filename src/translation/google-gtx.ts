// The one and only TranslationProvider for v1: the unofficial
// translate.googleapis.com/translate_a/single endpoint (decision #2).
//
// Phase 0 spike findings (see the report for the full numbers):
//   - Multiple `q=` parameters in one request are NOT batched by this
//     endpoint - only the first is translated. Real batching instead comes
//     from joining several lines with "\n" into a SINGLE `q` value; Google
//     returns one array element per *its own* sentence split, which does
//     not always line up 1:1 with our input lines (it can further split a
//     line that itself contains two sentences). We regroup the response
//     back to our input line count using the fact that each element's
//     *original*-text field ends with "\n" exactly when it closed one of
//     our input lines.
//   - The endpoint 400s once the built URL exceeds ~16.3k characters.
//   - No 429 was observed even at 15 concurrent requests in the spike, but
//     we still cap concurrency and back off per R6 as a defensive measure.
import { chunkByLimits, runWithConcurrency, withBackoff } from '../core/batching';
import {
  AuthError,
  FatalError,
  RateLimitError,
  TransientError,
  type TranslationProvider,
  type TranslationResult,
} from './provider';

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

// Conservative raw-character (not encoded-byte) budget per request. A
// non-ASCII UTF-8 character can percent-encode to up to 12 characters
// (%XX per byte, 4 bytes worst case for CJK/emoji), so 1200 raw chars
// worst-cases to ~14.4k encoded chars - safely under the ~16.3k boundary
// even for source text that isn't Latin script.
const MAX_CHARS_PER_REQUEST = 1200;
const MAX_ITEMS_PER_REQUEST = 100;
const MAX_CONCURRENCY = 3;
const MAX_ATTEMPTS = 3;

function buildUrl(joinedText: string, from: string, to: string): string {
  const params = new URLSearchParams();
  params.set('client', 'gtx');
  params.set('sl', from);
  params.set('tl', to);
  params.set('dt', 't');
  params.set('q', joinedText);
  return `${ENDPOINT}?${params.toString()}`;
}

function stripTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

/**
 * Parses the gtx dt=t response and regroups its segments back to exactly
 * `expectedCount` entries (one per input line). Throws FatalError if the
 * shape is unrecognizable or the regrouped count doesn't match - a silent
 * count mismatch would desync sentence pairing for every sentence after it.
 */
function parseAndRegroup(body: string, expectedCount: number): { translated: string[]; detectedLang?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new FatalError('Translate response was not valid JSON');
  }
  if (!Array.isArray(parsed) || !Array.isArray(parsed[0])) {
    throw new FatalError('Translate response had an unexpected shape');
  }

  const segments = parsed[0] as Array<[string | undefined, string | undefined, ...unknown[]]>;
  const detectedLangRaw = parsed[2];
  const detectedLang = typeof detectedLangRaw === 'string' ? detectedLangRaw : undefined;

  const grouped: string[] = [];
  let current = '';
  for (const seg of segments) {
    const [translated, original] = seg;
    current += translated ?? '';
    if (typeof original === 'string' && original.endsWith('\n')) {
      grouped.push(stripTrailingNewline(current));
      current = '';
    }
  }
  if (current.length > 0) grouped.push(stripTrailingNewline(current));

  if (grouped.length !== expectedCount) {
    throw new FatalError(`Translate response line count (${grouped.length}) did not match request (${expectedCount})`);
  }
  return { translated: grouped, detectedLang };
}

function classifyHttpError(status: number, bodySnippet: string): never {
  if (status === 429) throw new RateLimitError('Rate limited (HTTP 429)');
  if (status === 401 || status === 403) throw new AuthError(`Request rejected (HTTP ${status})`);
  if (status >= 500) throw new TransientError(`Server error (HTTP ${status})`);
  throw new FatalError(`Unexpected HTTP ${status}: ${bodySnippet.slice(0, 200)}`);
}

async function translateOneRequest(
  texts: string[],
  from: string,
  to: string,
  signal: AbortSignal
): Promise<TranslationResult[]> {
  // Guard against a literal newline inside one sentence, which would be
  // mistaken for our own line separator by the regrouping logic above.
  // segment.ts should never produce one, but never trust it blindly.
  const joined = texts.map((t) => t.replace(/\n/g, ' ')).join('\n');
  const url = buildUrl(joined, from, to);

  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new TransientError(err instanceof Error ? err.message : 'Network request failed');
  }

  const body = await res.text();
  if (!res.ok) classifyHttpError(res.status, body);

  const { translated, detectedLang } = parseAndRegroup(body, texts.length);
  return translated.map((text) => ({ text, detectedLang }));
}

function isRetryable(err: unknown): boolean {
  return err instanceof RateLimitError || err instanceof TransientError;
}

export const googleGtxProvider: TranslationProvider = {
  id: 'google-gtx',
  label: 'Google Translate (unofficial)',
  needsApiKey: false,
  limits: {
    maxItemsPerRequest: MAX_ITEMS_PER_REQUEST,
    maxCharsPerRequest: MAX_CHARS_PER_REQUEST,
    maxConcurrency: MAX_CONCURRENCY,
  },

  async translate(texts, opts) {
    if (texts.length === 0) return [];

    // Self-chunks to its own limits regardless of how the caller already
    // batched things - defense in depth, and keeps this function correct
    // even if called directly with an oversized list.
    const chunks = chunkByLimits(
      texts.map((text) => ({ text })),
      { maxItemsPerRequest: MAX_ITEMS_PER_REQUEST, maxCharsPerRequest: MAX_CHARS_PER_REQUEST }
    );

    const perChunkResults = await runWithConcurrency(chunks, MAX_CONCURRENCY, (chunk) =>
      withBackoff(() => translateOneRequest(chunk.map((c) => c.text), opts.from, opts.to, opts.signal), {
        maxAttempts: MAX_ATTEMPTS,
        baseDelayMs: 500,
        maxDelayMs: 8_000,
        isRetryable,
      })
    );

    return perChunkResults.flat();
  },
};
