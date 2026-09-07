import { describe, expect, it, vi } from 'vitest';
import { chunkByLimits, runWithConcurrency, withBackoff } from './batching';

describe('chunkByLimits', () => {
  it('respects maxItemsPerRequest', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ text: `s${i}` }));
    const chunks = chunkByLimits(items, { maxItemsPerRequest: 4, maxCharsPerRequest: 1000 });
    expect(chunks.map((c) => c.length)).toEqual([4, 4, 2]);
  });

  it('respects maxCharsPerRequest', () => {
    const items = [{ text: 'a'.repeat(30) }, { text: 'b'.repeat(30) }, { text: 'c'.repeat(30) }];
    const chunks = chunkByLimits(items, { maxItemsPerRequest: 100, maxCharsPerRequest: 50 });
    expect(chunks).toHaveLength(3); // each item alone already close to the cap, so no two fit together
  });

  it('preserves item order across chunks', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ text: `${i}` }));
    const chunks = chunkByLimits(items, { maxItemsPerRequest: 3, maxCharsPerRequest: 1000 });
    expect(chunks.flat().map((i) => i.text)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
  });

  it('places an oversized single item alone rather than dropping it', () => {
    const items = [{ text: 'a'.repeat(200) }];
    const chunks = chunkByLimits(items, { maxItemsPerRequest: 100, maxCharsPerRequest: 50 });
    expect(chunks).toEqual([[{ text: 'a'.repeat(200) }]]);
  });

  it('returns no chunks for an empty list', () => {
    expect(chunkByLimits([], { maxItemsPerRequest: 10, maxCharsPerRequest: 100 })).toEqual([]);
  });
});

describe('runWithConcurrency', () => {
  it('never exceeds the concurrency cap and preserves result order', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    const results = await runWithConcurrency(items, 3, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return item * 2;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(results).toEqual(items.map((i) => i * 2));
  });

  it('handles an empty item list', async () => {
    const results = await runWithConcurrency([], 3, async (i: number) => i);
    expect(results).toEqual([]);
  });
});

describe('withBackoff', () => {
  it('returns the result immediately on first success without sleeping', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      isRetryable: () => true,
      sleep,
    });
    expect(result).toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a retryable error up to maxAttempts then succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('rate limited');
      return 'ok';
    });
    const result = await withBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      isRetryable: () => true,
      sleep,
      random: () => 0.5,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('rethrows immediately for a non-retryable error without sleeping', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));
    await expect(
      withBackoff(fn, { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100, isRetryable: () => false, sleep })
    ).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up and rethrows after maxAttempts retryable failures', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(new Error('always rate limited'));
    await expect(
      withBackoff(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, isRetryable: () => true, sleep })
    ).rejects.toThrow('always rate limited');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('caps delay at maxDelayMs and blends in jitter', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls <= 4) throw new Error('retry me');
      return 'ok';
    });
    await withBackoff(fn, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 250,
      isRetryable: () => true,
      sleep,
      random: () => 1, // maximum jitter
    });
    // attempt1 fail -> exp=100 -> delay=100*0.5+1*100*0.5=100
    // attempt2 fail -> exp=200 -> delay=200*0.5+1*200*0.5=200
    // attempt3 fail -> exp=min(250,400)=250 -> delay=250*0.5+1*250*0.5=250
    // attempt4 fail -> exp=250 (capped) -> delay=250
    expect(delays).toEqual([100, 200, 250, 250]);
  });
});
