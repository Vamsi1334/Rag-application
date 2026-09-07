/**
 * Splitting a document into passages.
 *
 * ------------------------------------------------------------------
 * Why a document cannot be used whole
 * ------------------------------------------------------------------
 * Two hard limits, both unavoidable.
 *
 * The embedding model produces ONE vector per input. Embed a fifty page PDF
 * and you get a single point that is the average of everything in it, which is
 * near nothing in particular. Ask "what is the refund window" and that vector
 * is no closer to your question than a vector for any other long document.
 *
 * The answering model has a fixed context window. Even if retrieval were
 * perfect, a fifty page document does not fit in 8192 tokens alongside the
 * question and the answer.
 *
 * So the document is cut into passages. The passage becomes the unit that gets
 * embedded, retrieved and cited, and chunking quality sets a ceiling on
 * retrieval quality that no amount of model choice can lift.
 *
 * ------------------------------------------------------------------
 * The trade this file makes
 * ------------------------------------------------------------------
 * Small chunks match a question sharply but arrive without the context that
 * explains them: you retrieve a sentence saying "this does not apply to
 * enterprise plans" with no way to know what "this" was.
 *
 * Large chunks carry their context but dilute the match, because one vector
 * has to represent everything in the passage. A chunk covering four topics is
 * a mediocre match for all four.
 *
 * There is no correct answer, only a setting that suits a corpus. That is why
 * the numbers live in configuration rather than here, and why this file
 * measures rather than assumes.
 *
 * ------------------------------------------------------------------
 * Characters, not tokens
 * ------------------------------------------------------------------
 * Chunking happens before any tokenizer is involved, and pulling one in would
 * mean loading model-specific vocabulary just to decide where to cut. The
 * conversion is stable enough for the purpose: roughly four characters per
 * token in English prose. That ratio is written down once, in
 * `@/lib/tokens`, because the embedding provider budgets against it too.
 */

import { estimateTokens } from '@/lib/tokens';

/**
 * Re-exported, not redefined.
 *
 * The embedding provider budgets its request size with the same estimate, and
 * two copies of the ratio would drift. When they drift, the symptom is
 * rate-limit failures that appear only on documents of a certain shape, which
 * is a miserable thing to trace back to a constant.
 *
 * Re-exported rather than moved outright so every existing import of
 * `estimateTokens` from this module keeps working.
 */
export { estimateTokens };

export interface ChunkingOptions {
  /** Target passage length in characters. */
  chunkSize: number;
  /** How much of the previous passage each one repeats. */
  overlap: number;
}

export interface TextChunk {
  /** Position in the document, from zero. Used for ordering and neighbour lookup. */
  chunkIndex: number;
  content: string;
  /** Approximate. Stored so prompt budgeting needs no tokenizer at query time. */
  tokenCount: number;
  /** Character offsets into the cleaned source, for citation highlighting later. */
  startOffset: number;
  endOffset: number;
}


/**
 * Normalises whitespace without destroying structure.
 *
 * Extracted text arrives with artefacts: Windows line endings, non-breaking
 * spaces from HTML, page-break characters from PDFs, and runs of blank lines
 * where a header or footer was stripped.
 *
 * Blank-line runs are collapsed to exactly two newlines rather than one,
 * because a double newline is the paragraph signal the splitter below relies
 * on. Flattening it would remove the best available evidence of where one idea
 * ends and the next begins.
 */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    // Non-breaking and other exotic spaces, which otherwise survive trimming
    // and quietly become part of a chunk's content.
    .replace(/[   ]/g, ' ')
    // Form feed and vertical tab: page breaks from PDF extraction.
    .replace(/[\f\v]/g, '\n')
    // Zero-width characters. Invisible, and they break word-boundary matching.
    .replace(/[​-‍﻿]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Finds a sensible place to cut, at or before `limit`.
 *
 * Preference order, best first: a paragraph break, then a sentence ending,
 * then a line break, then a space. Cutting mid-word is the last resort and
 * only happens when the text contains no break at all within the window, which
 * in practice means a base64 blob or a language this heuristic does not fit.
 *
 * `searchFloor` stops the splitter from walking back so far that chunks become
 * tiny: a paragraph break at 5 percent of the way in is worse than a clean
 * sentence break at 80 percent.
 */
function findBreakPoint(text: string, limit: number): number {
  if (limit >= text.length) return text.length;

  const searchFloor = Math.floor(limit * 0.6);
  const window = text.slice(0, limit);

  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph > searchFloor) return paragraph + 2;

  // Sentence end: punctuation followed by whitespace. Matching the LAST such
  // position means scanning forward and keeping the highest.
  let sentence = -1;
  const sentencePattern = /[.!?]["')\]]?\s/g;
  let match = sentencePattern.exec(window);
  while (match !== null) {
    sentence = match.index + match[0].length;
    match = sentencePattern.exec(window);
  }
  if (sentence > searchFloor) return sentence;

  const line = window.lastIndexOf('\n');
  if (line > searchFloor) return line + 1;

  const space = window.lastIndexOf(' ');
  if (space > searchFloor) return space + 1;

  // No usable boundary. Cut at the limit rather than producing one enormous
  // chunk that will not embed.
  return limit;
}

/**
 * Splits cleaned text into overlapping passages.
 *
 * Guarantees, each of which has a test:
 *   - chunkIndex runs 0, 1, 2 with no gaps
 *   - no chunk is empty or whitespace-only
 *   - text shorter than one chunk returns exactly one chunk
 *   - every character of the input appears in at least one chunk
 *   - the function terminates on any input
 */
export function chunkText(raw: string, options: ChunkingOptions): TextChunk[] {
  const text = cleanText(raw);
  if (text.length === 0) return [];

  const chunkSize = Math.max(1, Math.floor(options.chunkSize));
  /**
   * Overlap is clamped below the chunk size.
   *
   * If overlap were greater than or equal to chunkSize, each step would move
   * the cursor backwards or not at all, and the loop would never end. A
   * misconfigured environment variable should degrade the chunking, not hang
   * the ingestion worker.
   */
  const overlap = Math.min(Math.max(0, Math.floor(options.overlap)), chunkSize - 1);

  const chunks: TextChunk[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const remaining = text.length - cursor;

    /**
     * Absorb a short tail instead of emitting it alone.
     *
     * Without this, a document of 1900 characters at a 1800 chunk size
     * produces a 1800-character chunk and a 100-character orphan. That orphan
     * embeds badly, retrieves noisily and cites poorly. Letting the final
     * chunk run slightly over is the better failure.
     */
    const takeAll = remaining <= chunkSize + Math.floor(chunkSize * 0.25);
    const end = takeAll ? text.length : cursor + findBreakPoint(text.slice(cursor), chunkSize);

    const content = text.slice(cursor, end).trim();

    // A slice can be whitespace-only when the break point landed inside a run
    // of newlines. Skip it rather than storing an empty passage, which would
    // waste an embedding call and pollute search results.
    if (content.length > 0) {
      chunks.push({
        chunkIndex: chunks.length,
        content,
        tokenCount: estimateTokens(content),
        startOffset: cursor,
        endOffset: end,
      });
    }

    if (end >= text.length) break;

    const next = end - overlap;
    // Defence against a break point that failed to advance. Without it a
    // pathological input could loop forever.
    cursor = next > cursor ? next : end;
  }

  return chunks;
}
