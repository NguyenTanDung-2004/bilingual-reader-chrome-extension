import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleGtxProvider } from './google-gtx';
import { AuthError, FatalError, RateLimitError, TransientError } from './provider';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

describe('googleGtxProvider.translate', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('builds a newline-joined single q, sends it, and returns results in input order', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return jsonResponse(200, [
        [
          ['Xin chao.\n', 'Hello.\n', null, null, 3],
          ['The gioi.', 'World.', null, null, 3],
        ],
        null,
        'en',
      ]);
    }) as unknown as typeof fetch;

    const results = await googleGtxProvider.translate(['Hello.', 'World.'], {
      from: 'auto',
      to: 'vi',
      signal: new AbortController().signal,
    });

    expect(results).toEqual([
      { text: 'Xin chao.', detectedLang: 'en' },
      { text: 'The gioi.', detectedLang: 'en' },
    ]);
    expect(capturedUrl).toContain('client=gtx');
    expect(capturedUrl).toContain('sl=auto');
    expect(capturedUrl).toContain('tl=vi');
    expect(capturedUrl).toContain('q=Hello.%0AWorld.');
  });

  it('regroups a response where one input line was split into two output segments', async () => {
    // Simulates Google's own sentence splitter further dividing a single
    // input line (see the Phase 0 spike finding) - the *second* input line
    // comes back as two segments, only the last of which ends without "\n".
    global.fetch = vi.fn(async () =>
      jsonResponse(200, [
        [
          ['One.\n', 'One.\n', null, null, 3],
          ['Two A? ', 'Two A? ', null, null, 10],
          ['Two B.', 'Two B.', null, null, 3],
        ],
        null,
        'en',
      ])
    ) as unknown as typeof fetch;

    const results = await googleGtxProvider.translate(['One.', 'Two A? Two B.'], {
      from: 'auto',
      to: 'vi',
      signal: new AbortController().signal,
    });

    expect(results.map((r) => r.text)).toEqual(['One.', 'Two A? Two B.']);
  });

  it('replaces a literal newline inside a sentence so it cannot be mistaken for the line separator', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return jsonResponse(200, [[['ok.', 'weird text.\n', null, null, 3]], null, 'en']);
    }) as unknown as typeof fetch;

    await googleGtxProvider.translate(['weird\ntext.'], { from: 'auto', to: 'vi', signal: new AbortController().signal });
    expect(capturedUrl).not.toContain('%0Atext'); // the internal \n was replaced with a space, not left as a separator
    expect(capturedUrl).toContain('weird+text.');
  });

  it('throws RateLimitError on HTTP 429', async () => {
    global.fetch = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    await expect(
      googleGtxProvider.translate(['a'], { from: 'auto', to: 'vi', signal: new AbortController().signal })
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('throws AuthError on HTTP 403', async () => {
    global.fetch = vi.fn(async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
    await expect(
      googleGtxProvider.translate(['a'], { from: 'auto', to: 'vi', signal: new AbortController().signal })
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('throws TransientError on HTTP 500', async () => {
    global.fetch = vi.fn(async () => new Response('server error', { status: 500 })) as unknown as typeof fetch;
    await expect(
      googleGtxProvider.translate(['a'], { from: 'auto', to: 'vi', signal: new AbortController().signal })
    ).rejects.toBeInstanceOf(TransientError);
  });

  it('throws FatalError on an unparseable body', async () => {
    global.fetch = vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    await expect(
      googleGtxProvider.translate(['a'], { from: 'auto', to: 'vi', signal: new AbortController().signal })
    ).rejects.toBeInstanceOf(FatalError);
  });

  it('throws FatalError when the regrouped segment count does not match the request', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(200, [[['only one.', 'only one.\n', null, null, 3]], null, 'en'])
    ) as unknown as typeof fetch;
    await expect(
      googleGtxProvider.translate(['a', 'b'], { from: 'auto', to: 'vi', signal: new AbortController().signal })
    ).rejects.toBeInstanceOf(FatalError);
  });

  it('returns an empty array for an empty input without calling fetch', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const results = await googleGtxProvider.translate([], { from: 'auto', to: 'vi', signal: new AbortController().signal });
    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('retries once on a transient 500 then succeeds', async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('boom', { status: 500 });
      return jsonResponse(200, [[['ok.', 'a.\n', null, null, 3]], null, 'en']);
    }) as unknown as typeof fetch;

    const results = await googleGtxProvider.translate(['a.'], {
      from: 'auto',
      to: 'vi',
      signal: new AbortController().signal,
    });
    expect(results).toEqual([{ text: 'ok.', detectedLang: 'en' }]);
    expect(calls).toBe(2);
  }, 10_000);
});
