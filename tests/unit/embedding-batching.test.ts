import { describe, expect, it } from 'vitest';

import { pacingDelayMs, planEmbeddingBatches, retryDelayMs } from '@/server/ai/providers/voyage';
import { estimateTokens } from '@/lib/tokens';

/**
 * Batch planning and retry timing.
 *
 * Both are pure functions pulled out of the request path so they can be tested
 * without a network at all, which matters because the bug that produced them
 * only showed up against a real 62-page PDF on a real free-tier account.
 *
 * The failure was arithmetic, not luck: 49 chunks batched by COUNT into one
 * request of ~17,000 estimated tokens, against a free-trial ceiling of 10,000
 * tokens per minute. Refused on arrival, every time.
 */

/** A passage of roughly `tokens` estimated tokens. */
function passage(tokens: number): string {
  return 'x'.repeat(tokens * 4);
}

describe('planEmbeddingBatches', () => {
  it('keeps a small set in one request', () => {
    const batches = planEmbeddingBatches(['a', 'b', 'c'], 8000);

    expect(batches).toEqual([['a', 'b', 'c']]);
  });

  it('splits when the token budget would be exceeded', () => {
    const texts = [passage(400), passage(400), passage(400)];

    const batches = planEmbeddingBatches(texts, 1000);

    // Two fit inside 1,000 tokens; the third starts a new request.
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(2);
    expect(batches[1]).toHaveLength(1);
  });

  it('never exceeds the budget in any request', () => {
    const texts = Array.from({ length: 40 }, (_, i) => passage(300 + i));

    for (const batch of planEmbeddingBatches(texts, 2000)) {
      const tokens = batch.reduce((total, text) => total + estimateTokens(text), 0);
      // The one invariant that matters. Everything else is efficiency.
      expect(tokens).toBeLessThanOrEqual(2000);
    }
  });

  it('loses nothing and reorders nothing', () => {
    /**
     * Order is load-bearing. The caller pairs batch results back to chunks by
     * position, so a planner that dropped or shuffled a passage would store
     * every later chunk against the wrong vector, and nothing would throw.
     */
    const texts = Array.from({ length: 25 }, (_, i) => `${i}`.padEnd(600, 'x'));

    const flattened = planEmbeddingBatches(texts, 1000).flat();

    expect(flattened).toEqual(texts);
  });

  it('gives an oversized passage a request of its own', () => {
    // Rather than dropping it, or wedging it alongside others and breaching
    // the budget. Truncation is the vendor's call, asked for in the request.
    const texts = ['small', passage(5000), 'small again'];

    const batches = planEmbeddingBatches(texts, 1000);

    expect(batches.flat()).toEqual(texts);
    expect(batches).toContainEqual([passage(5000)]);
  });

  it('still respects the hard count ceiling for very short passages', () => {
    // A thousand one-word passages are only a few thousand tokens, so the
    // token budget alone would put them all in one request and breach the
    // vendor's per-request input limit instead.
    const texts = Array.from({ length: 500 }, (_, i) => `${i}`);

    for (const batch of planEmbeddingBatches(texts, 1_000_000, 128)) {
      expect(batch.length).toBeLessThanOrEqual(128);
    }
  });

  it('returns nothing for no input', () => {
    expect(planEmbeddingBatches([], 8000)).toEqual([]);
  });
});

describe('retryDelayMs', () => {
  it('honours Retry-After in seconds', () => {
    // The server knows when its own window resets. A guess cannot beat that.
    expect(retryDelayMs('30', 0, 2000)).toBe(30_000);
  });

  it('honours Retry-After as an HTTP date', () => {
    const tenSecondsOut = new Date(Date.now() + 10_000).toUTCString();

    const delay = retryDelayMs(tenSecondsOut, 0, 2000);

    expect(delay).toBeGreaterThan(8000);
    expect(delay).toBeLessThanOrEqual(10_000);
  });

  it('never returns a negative wait for a date in the past', () => {
    // A clock skewed the wrong way would otherwise turn "wait" into "retry
    // instantly", which is the opposite of what the server asked for.
    const past = new Date(Date.now() - 60_000).toUTCString();

    expect(retryDelayMs(past, 0, 2000)).toBe(0);
  });

  it('backs off exponentially when the header is absent', () => {
    expect(retryDelayMs(null, 0, 2000)).toBe(2000);
    expect(retryDelayMs(null, 1, 2000)).toBe(4000);
    expect(retryDelayMs(null, 2, 2000)).toBe(8000);
  });

  it('ignores a header that is not a number or a date', () => {
    expect(retryDelayMs('soon', 1, 2000)).toBe(4000);
  });

  it('caps the wait, so one unlucky batch cannot stall a run indefinitely', () => {
    expect(retryDelayMs('99999', 0, 2000)).toBe(120_000);
    expect(retryDelayMs(null, 20, 2000)).toBe(120_000);
  });
});

describe('pacingDelayMs', () => {
  it('waits the request gap when requests are the binding limit', () => {
    // 3 per minute is a 20-second gap. A small batch does not add to it.
    expect(pacingDelayMs(500, 3, 10_000)).toBe(20_000);
  });

  it('waits longer when the tokens just sent are the binding limit', () => {
    /**
     * The bug this function exists to prevent.
     *
     * 3 requests per minute at 8,000 tokens each honours the request rate
     * perfectly and breaches a 10,000-token minute more than twice over. The
     * request gap alone says 20 seconds; the tokens say 48, and 48 is the
     * answer that avoids a 429.
     */
    expect(pacingDelayMs(8000, 3, 10_000)).toBe(48_000);
  });

  it('is effectively no wait on a paid tier', () => {
    // Tier 1 with a payment method: 2,000 RPM and 16M TPM for voyage-4-lite.
    // Pacing must not throttle a limit that is three orders of magnitude away.
    expect(pacingDelayMs(8000, 2000, 16_000_000)).toBeLessThan(100);
  });

  it('scales with batch size once tokens are what binds', () => {
    /**
     * Twice the tokens, twice the wait, so total time tracks how much text
     * there is rather than how it was divided into requests.
     *
     * Both figures have to be large enough that tokens are the binding limit.
     * At 2,000 tokens against 10,000 per minute the answer is 12 seconds,
     * which the 20-second request gap swallows, and the doubling is invisible.
     */
    const small = pacingDelayMs(4000, 3, 10_000);
    const large = pacingDelayMs(8000, 3, 10_000);

    expect(small).toBe(24_000);
    expect(large).toBe(small * 2);
  });

  it('falls back to the request gap for a batch too small to matter', () => {
    // The floor. Even a one-token request waits its turn in the request rate.
    expect(pacingDelayMs(1, 3, 10_000)).toBe(20_000);
  });

  it('never divides by zero on a nonsensical limit', () => {
    expect(Number.isFinite(pacingDelayMs(1000, 0, 0))).toBe(true);
  });
});
