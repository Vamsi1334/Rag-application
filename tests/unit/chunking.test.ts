import { describe, expect, it } from 'vitest';

import { chunkText, cleanText, estimateTokens } from '@/server/rag/chunking';

/**
 * Chunking.
 *
 * Chunking quality sets a ceiling on retrieval quality that no model choice
 * can lift, and its failures are quiet. A dropped character, a mis-numbered
 * chunk or an empty passage does not throw; it just makes search worse in a
 * way nobody traces back here months later.
 *
 * So these assert properties rather than exact output: no gaps in the
 * ordering, nothing empty, nothing lost, and termination on any input.
 */

const OPTIONS = { chunkSize: 200, overlap: 40 };

/** Prose with real paragraph and sentence breaks to find. */
function prose(paragraphs: number): string {
  return Array.from(
    { length: paragraphs },
    (_, i) =>
      `Paragraph ${i} opens with a sentence about search engines. ` +
      `It continues with a second sentence that carries the idea further. ` +
      `A third closes the thought neatly.`,
  ).join('\n\n');
}

describe('cleanText', () => {
  it('collapses runs of blank lines to a single paragraph break', () => {
    // Kept as two newlines rather than one: the double newline is the
    // paragraph signal the splitter uses to find good break points.
    expect(cleanText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('normalises Windows line endings', () => {
    expect(cleanText('a\r\nb')).toBe('a\nb');
  });

  it('replaces non-breaking spaces, which survive an ordinary trim', () => {
    expect(cleanText('a  b')).toBe('a b');
  });

  it('strips zero-width characters that break word matching', () => {
    expect(cleanText('a​b﻿c')).toBe('abc');
  });

  it('turns PDF page breaks into line breaks', () => {
    expect(cleanText('page one\fpage two')).toBe('page one\npage two');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(cleanText('   \n\n\t  ')).toBe('');
  });
});

describe('short documents', () => {
  it('returns exactly one chunk when the text fits', () => {
    const chunks = chunkText('A single short sentence about SEO.', OPTIONS);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunkIndex).toBe(0);
    expect(chunks[0]?.content).toBe('A single short sentence about SEO.');
  });

  it('returns nothing for empty input', () => {
    expect(chunkText('', OPTIONS)).toEqual([]);
  });

  it('returns nothing for whitespace-only input', () => {
    // A scanned page with no extractable text produces exactly this. It must
    // not become a chunk: whitespace embeds to a vector that falsely matches
    // unrelated questions.
    expect(chunkText('   \n\n   \t  ', OPTIONS)).toEqual([]);
  });
});

describe('long documents', () => {
  const chunks = chunkText(prose(20), OPTIONS);

  it('produces several chunks', () => {
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('numbers them consecutively from zero with no gaps', () => {
    // Gaps would break neighbour lookup and citation ordering.
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it('never emits an empty or whitespace-only chunk', () => {
    for (const chunk of chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps chunks near the requested size', () => {
    // The last one is allowed to run over: a short tail is absorbed rather
    // than left as an orphan that embeds and retrieves badly.
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.content.length).toBeLessThanOrEqual(OPTIONS.chunkSize);
    }
  });

  it('loses no content from the middle of the document', () => {
    // The property that matters most. A retrieval system that silently drops
    // a paragraph answers questions wrongly with total confidence.
    const source = prose(20);
    const rejoined = chunks.map((c) => c.content).join(' ');

    for (const marker of ['Paragraph 0 ', 'Paragraph 9 ', 'Paragraph 19 ']) {
      expect(rejoined).toContain(marker.trim());
    }
    expect(chunks.at(-1)?.endOffset).toBe(source.length);
  });

  it('records offsets that point back into the cleaned source', () => {
    const source = prose(20);
    for (const chunk of chunks) {
      expect(source.slice(chunk.startOffset, chunk.endOffset)).toContain(
        chunk.content.slice(0, 20),
      );
    }
  });
});

describe('overlap', () => {
  it('repeats text between neighbouring chunks', () => {
    const chunks = chunkText(prose(10), { chunkSize: 300, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);

    const first = chunks[0];
    const second = chunks[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // Without overlap, a sentence straddling a boundary is cut in half and
    // neither half retrieves well. The tail of one chunk should reappear.
    const tail = first!.content.slice(-40).trim();
    expect(second!.content).toContain(tail.slice(0, 20));
  });

  it('works with no overlap at all', () => {
    const chunks = chunkText(prose(10), { chunkSize: 300, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it('terminates when overlap is larger than the chunk size', () => {
    // A misconfigured environment variable would otherwise move the cursor
    // backwards on every step and hang the ingestion worker forever. The
    // overlap is clamped instead.
    const chunks = chunkText(prose(5), { chunkSize: 100, overlap: 500 });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });
});

describe('where it cuts', () => {
  it('prefers a paragraph boundary', () => {
    const text = `${'a'.repeat(120)}\n\n${'b'.repeat(400)}`;
    const chunks = chunkText(text, { chunkSize: 200, overlap: 0 });

    expect(chunks[0]?.content).toBe('a'.repeat(120));
  });

  it('falls back to a sentence ending', () => {
    const text = `${'Word '.repeat(30)}end. ${'Other '.repeat(60)}`;
    const chunks = chunkText(text, { chunkSize: 200, overlap: 0 });

    expect(chunks[0]?.content.endsWith('end.')).toBe(true);
  });

  it('avoids splitting mid-word when a space is available', () => {
    const chunks = chunkText('word '.repeat(200), { chunkSize: 200, overlap: 0 });

    for (const chunk of chunks) {
      expect(chunk.content).not.toMatch(/\bwor$/);
    }
  });

  it('still terminates on text with no break points at all', () => {
    // A base64 blob or a language this heuristic does not fit. Cutting
    // mid-token is the correct last resort; hanging is not.
    const chunks = chunkText('x'.repeat(1000), { chunkSize: 200, overlap: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length > 0)).toBe(true);
  });
});

describe('token estimation', () => {
  it('scales with length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('is recorded on every chunk, so query time needs no tokenizer', () => {
    const chunks = chunkText(prose(5), OPTIONS);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBe(estimateTokens(chunk.content));
    }
  });
});
