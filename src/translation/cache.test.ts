import { describe, expect, it, vi } from 'vitest';
import { hashString } from '../core/ids';
import { translateWithCache } from './cache';
import type { TranslationProvider } from './provider';

vi.mock('../storage/fs-cache', () => ({
  readArticleCache: vi.fn(),
}));

import { readArticleCache } from '../storage/fs-cache';

function fakeProvider(translate: TranslationProvider['translate']): TranslationProvider {
  return {
    id: 'fake',
    label: 'Fake',
    needsApiKey: false,
    limits: { maxItemsPerRequest: 100, maxCharsPerRequest: 10_000, maxConcurrency: 3 },
    translate,
  };
}

describe('translateWithCache', () => {
  it('serves a pure cache hit without calling the provider', async () => {
    vi.mocked(readArticleCache).mockResolvedValue({
      url: 'https://example.com/a',
      updatedAt: 0,
      translations: { [hashString('Hello.')]: { text: 'Xin chao.', detectedLang: 'en' } },
    });
    const translate = vi.fn();
    const provider = fakeProvider(translate);

    const results = await translateWithCache(
      provider,
      'cachekey1',
      [{ id: 's1', text: 'Hello.' }],
      'auto',
      'vi',
      new AbortController().signal
    );

    expect(results).toEqual([{ id: 's1', text: 'Xin chao.', detectedLang: 'en', fromCache: true }]);
    expect(translate).not.toHaveBeenCalled();
  });

  it('calls the provider only for cache misses and preserves input order', async () => {
    vi.mocked(readArticleCache).mockResolvedValue({
      url: 'https://example.com/a',
      updatedAt: 0,
      translations: { [hashString('Cached.')]: { text: 'Da luu.' } },
    });
    const translate = vi.fn(async (texts: string[]) => texts.map((t) => ({ text: `T(${t})` })));
    const provider = fakeProvider(translate);

    const results = await translateWithCache(
      provider,
      'cachekey1',
      [
        { id: 's1', text: 'Miss one.' },
        { id: 's2', text: 'Cached.' },
        { id: 's3', text: 'Miss two.' },
      ],
      'auto',
      'vi',
      new AbortController().signal
    );

    expect(results).toEqual([
      { id: 's1', text: 'T(Miss one.)', detectedLang: undefined, fromCache: false },
      { id: 's2', text: 'Da luu.', detectedLang: undefined, fromCache: true },
      { id: 's3', text: 'T(Miss two.)', detectedLang: undefined, fromCache: false },
    ]);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0]?.[0]).toEqual(['Miss one.', 'Miss two.']);
  });

  it('works with no cache at all (fresh article) - everything is a miss', async () => {
    vi.mocked(readArticleCache).mockResolvedValue(null);
    const translate = vi.fn(async (texts: string[]) => texts.map((t) => ({ text: `T(${t})` })));
    const provider = fakeProvider(translate);

    const results = await translateWithCache(
      provider,
      'cachekey2',
      [{ id: 's1', text: 'New.' }],
      'auto',
      'vi',
      new AbortController().signal
    );
    expect(results).toEqual([{ id: 's1', text: 'T(New.)', detectedLang: undefined, fromCache: false }]);
  });

  it('does not call the provider at all when every item is empty', async () => {
    vi.mocked(readArticleCache).mockResolvedValue(null);
    const translate = vi.fn();
    const provider = fakeProvider(translate);
    const results = await translateWithCache(provider, 'k', [], 'auto', 'vi', new AbortController().signal);
    expect(results).toEqual([]);
    expect(translate).not.toHaveBeenCalled();
  });
});
