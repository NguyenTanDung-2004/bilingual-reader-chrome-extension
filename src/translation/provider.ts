// The provider interface. Every provider-specific concern (request
// shaping, response parsing, error mapping) lives inside that provider's
// own file (google-gtx.ts); the batching/retry/cache layers only ever see
// this interface plus the standardized error classes below.
import type { TranslationErrorKind } from '../core/messages';

export abstract class TranslationError extends Error {
  abstract readonly kind: TranslationErrorKind;
}

/** Provider signaled "too many requests" (HTTP 429 or equivalent). Retryable with backoff. */
export class RateLimitError extends TranslationError {
  readonly kind = 'rate_limit';
}

/** Provider rejected the request as unauthorized/forbidden. Not retryable without user action. */
export class AuthError extends TranslationError {
  readonly kind = 'auth';
}

/** Network hiccup / 5xx / timeout. Retryable. */
export class TransientError extends TranslationError {
  readonly kind = 'transient';
}

/** Anything else (malformed response, programming error, unsupported language, ...). Not retryable. */
export class FatalError extends TranslationError {
  readonly kind = 'fatal';
}

export interface TranslationResult {
  text: string;
  detectedLang?: string;
}

export interface TranslateOptions {
  from: string; // 'auto' or a BCP-47-ish code
  to: string;
  signal: AbortSignal;
}

export interface TranslationProviderLimits {
  maxItemsPerRequest: number;
  maxCharsPerRequest: number;
  maxConcurrency: number;
}

export interface TranslationProvider {
  readonly id: string;
  readonly label: string;
  readonly needsApiKey: boolean;
  readonly limits: TranslationProviderLimits;
  /** `texts.length === ` the returned array's length, same order. Throws a TranslationError subclass on failure. */
  translate(texts: string[], opts: TranslateOptions): Promise<TranslationResult[]>;
}
