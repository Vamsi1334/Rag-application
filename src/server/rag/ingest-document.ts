import 'server-only';

import { createHash } from 'node:crypto';

import { isAppError, toAppError } from '@/server/observability/errors';
import { logError, logInfo } from '@/server/observability/logger';
import {
  createDocument,
  findDocumentByChecksumForUser,
  updateDocumentStatusForUser,
} from '@/server/db/repositories/documents.repo';
import {
  deleteChunksForDocument,
  insertDocumentChunks,
} from '@/server/db/repositories/document-chunks.repo';
import { KNOWLEDGE_BASE_OWNER_ID } from '@/server/db/types';
import { chunkText, type TextChunk } from './chunking';
import { embedDocumentChunks, getChunkingOptions, getEmbeddingModelInfo } from './embedding-service';
import { extractDocumentText, type ExtractedDocument } from './extract-text';

/**
 * Turning one file into searchable passages.
 *
 * ------------------------------------------------------------------
 * This is an ADMINISTRATIVE operation
 * ------------------------------------------------------------------
 * There is deliberately no HTTP route that calls this, and normal users have
 * no way to reach it. In this version the application serves one shared
 * company knowledge base, curated by whoever runs the project, and a signed-in
 * user only asks questions.
 *
 * The entry point is `scripts/ingest-document.ts`, run from a terminal.
 * Authorization is therefore possession of the server's own credentials, which
 * is a stronger boundary than any role check: there is no endpoint to find, no
 * session to forge, and no bug in a permission check to exploit, because none
 * of those things exist.
 *
 * If a real upload feature is wanted later, that is the moment to add roles
 * and a route. Adding them now would be unused machinery guarding nothing.
 *
 * ------------------------------------------------------------------
 * The pipeline
 * ------------------------------------------------------------------
 *   file -> extract -> clean -> chunk -> embed -> store
 *
 * Each step is a separate module so each can be tested on its own. This file
 * only sequences them and owns what happens when one fails.
 */

/** How far the document got. Reported by the script and stored on the row. */
export interface IngestionResult {
  documentId: string;
  status: 'ready' | 'failed' | 'skipped';
  originalName: string;
  characterCount: number;
  pageCount: number;
  chunkCount: number;
  embeddingModel: string;
  embeddingDimensions: number;
  durationMs: number;
  /** Present only on failure. Safe to display. */
  error?: string;
}

export interface IngestOptions {
  bytes: Uint8Array;
  originalName: string;
  mimeType: string;
  /**
   * Re-ingest a file already present, replacing its chunks.
   *
   * Off by default so an accidental second run is a no-op rather than silently
   * doubling the corpus.
   */
  force?: boolean;
}

/**
 * Attaches a page number to each chunk, where one can be known.
 *
 * The chunker works on the whole document as one string and reports character
 * offsets. Mapping an offset back to a page means knowing where each page
 * started in that string, which is what this rebuilds.
 *
 * Only ever returns a page it can actually justify. A chunk spanning a page
 * boundary is attributed to the page it starts on, and a document without
 * pages gets nothing at all, because a citation pointing at an invented page
 * is worse than one with no page: it looks checkable and is not.
 */
function mapChunksToPages(
  chunks: TextChunk[],
  extracted: ExtractedDocument,
): (number | undefined)[] {
  if (extracted.pages.length === 0) return chunks.map(() => undefined);

  // Page boundaries in the same joined string the chunker measured against.
  const boundaries: { start: number; end: number; pageNumber: number }[] = [];
  let cursor = 0;
  const separator = '\n\n';

  for (const page of extracted.pages) {
    boundaries.push({
      start: cursor,
      end: cursor + page.text.length,
      pageNumber: page.pageNumber,
    });
    cursor += page.text.length + separator.length;
  }

  return chunks.map((chunk) => {
    const page = boundaries.find(
      (candidate) => chunk.startOffset >= candidate.start && chunk.startOffset <= candidate.end,
    );
    return page?.pageNumber;
  });
}

/**
 * Runs the whole pipeline for one file.
 *
 * ------------------------------------------------------------------
 * How partial failure is handled
 * ------------------------------------------------------------------
 * MongoDB has no transaction spanning "call an external API 40 times, then
 * write 400 rows", and reaching for one would be the wrong tool anyway. What
 * matters is not that the write is atomic, but that the DOCUMENT'S STATUS
 * NEVER LIES.
 *
 * So the order is deliberate:
 *
 *   1. Embed everything first, in memory. Nothing is written yet.
 *   2. Only once every vector exists, delete old chunks and insert new ones.
 *   3. Only once every chunk is stored does the document become `ready`.
 *
 * If embedding fails at chunk 70 of 100, no chunks were written at all and the
 * document is marked `failed` with the reason. The corpus is never left
 * holding a partially embedded document that looks complete and answers
 * questions from two thirds of a file.
 *
 * The cost is holding all the vectors in memory before writing. For one
 * company document that is a few megabytes. If this ever ingests something
 * large enough for that to hurt, the fix is batching per section with a
 * `chunked` intermediate status, which the status enum already allows for.
 */
export async function ingestDocument(options: IngestOptions): Promise<IngestionResult> {
  const startedAt = Date.now();
  const { bytes, originalName, mimeType } = options;

  // The embedding model is resolved up front so a misconfiguration fails
  // before a file is parsed, not after.
  const model = getEmbeddingModelInfo();

  /**
   * Identity of the file, not of the upload.
   *
   * Hashing the contents means re-running the script on the same file is
   * recognised as the same document, so a second run cannot quietly create a
   * duplicate set of chunks that would then both surface in search results.
   */
  const checksum = createHash('sha256').update(bytes).digest('hex');

  logInfo(
    {
      operation: 'rag.ingest',
      status: 'started',
      mimeType,
      sizeBytes: bytes.byteLength,
      embeddingModel: model.model,
      embeddingDimensions: model.dimensions,
    },
    'Ingestion started',
  );

  const existing = await findDocumentByChecksumForUser(checksum, KNOWLEDGE_BASE_OWNER_ID);

  /**
   * Only a COMPLETE document is worth skipping.
   *
   * The check is `status === 'ready'`, not merely "a row exists". A row can
   * exist and be useless: `failed` because the API key was wrong, or stuck at
   * `embedding` because the process was killed halfway. Neither has a chunk set
   * anybody is using, so there is nothing to protect by refusing to redo it.
   *
   * Treating those as "already ingested" was worse than useless. Re-running the
   * exact command that just failed printed "Nothing changed" and exited 0, so
   * the fix for a transient failure looked like success, and in a shell chain
   * or a CI step it would have been indistinguishable from one.
   *
   * So `--force` now means what its name says: redo work that is already
   * finished. Redoing work that never finished needs no flag.
   */
  if (existing && existing.status === 'ready' && !options.force) {
    logInfo(
      {
        operation: 'rag.ingest',
        status: 'skipped',
        documentId: existing._id.toHexString(),
        chunkCount: existing.chunkCount,
      },
      'Document already ingested; skipping',
    );

    return {
      documentId: existing._id.toHexString(),
      status: 'skipped',
      originalName: existing.originalName,
      characterCount: 0,
      pageCount: 0,
      chunkCount: existing.chunkCount,
      embeddingModel: model.model,
      embeddingDimensions: model.dimensions,
      durationMs: Date.now() - startedAt,
    };
  }

  if (existing && existing.status !== 'ready') {
    logInfo(
      {
        operation: 'rag.ingest',
        status: 'retrying',
        documentId: existing._id.toHexString(),
        // Which state it was stuck in, which is the useful half of knowing a
        // retry happened at all.
        stage: existing.status,
      },
      'Document exists but was never completed; reprocessing',
    );
  }

  const document =
    existing ??
    (await createDocument({
      userId: KNOWLEDGE_BASE_OWNER_ID,
      scope: 'shared',
      originalName,
      mimeType,
      sizeBytes: bytes.byteLength,
      checksum,
    }));

  const documentId = document._id.toHexString();

  try {
    // ---- extract ---------------------------------------------------------
    await updateDocumentStatusForUser(documentId, KNOWLEDGE_BASE_OWNER_ID, 'extracting');

    const extracted = await extractDocumentText(bytes, mimeType);

    logInfo(
      {
        operation: 'rag.ingest',
        status: 'extracted',
        documentId,
        // Counts and page totals only. Never the text: it is the document.
        sizeBytes: extracted.characterCount,
        pageCount: extracted.pageCount,
      },
      'Text extracted',
    );

    // ---- chunk -----------------------------------------------------------
    await updateDocumentStatusForUser(documentId, KNOWLEDGE_BASE_OWNER_ID, 'chunking');

    const chunks = chunkText(extracted.text, getChunkingOptions());

    if (chunks.length === 0) {
      // Extraction found text but chunking produced nothing, which should be
      // impossible. Failing loudly beats storing a document with no passages.
      throw new Error('Chunking produced no passages from a non-empty document');
    }

    const pageNumbers = mapChunksToPages(chunks, extracted);

    logInfo(
      { operation: 'rag.ingest', status: 'chunked', documentId, chunkCount: chunks.length },
      'Text chunked',
    );

    // ---- embed -----------------------------------------------------------
    // Everything, before anything is written. See the comment above.
    await updateDocumentStatusForUser(documentId, KNOWLEDGE_BASE_OWNER_ID, 'embedding');

    const embedded = await embedDocumentChunks(chunks.map((chunk) => chunk.content));

    /**
     * The dimension check, immediately before anything is stored.
     *
     * The Atlas index declares a fixed vector length and every stored vector
     * must match it. A mismatch does not fail loudly at write time: the rows
     * land, the index quietly refuses to index them, and search returns
     * nothing for a document that looks perfectly ingested.
     */
    for (const [index, vector] of embedded.entries()) {
      if (vector.dimensions !== model.dimensions || vector.vector.length !== model.dimensions) {
        throw new Error(
          `Embedding ${index} has ${vector.vector.length} dimensions, ` +
            `but the vector index expects ${model.dimensions}`,
        );
      }
    }

    // ---- store -----------------------------------------------------------
    /**
     * Replace rather than append.
     *
     * A re-ingest with `force` would otherwise leave the previous chunks in
     * place alongside the new ones, and search would return the same passage
     * twice from two generations of the same file. Deleting first is also what
     * makes re-running after a failure clean rather than cumulative.
     */
    const removed = await deleteChunksForDocument(documentId, KNOWLEDGE_BASE_OWNER_ID);
    if (removed > 0) {
      logInfo(
        { operation: 'rag.ingest', status: 'replaced', documentId, chunkCount: removed },
        'Removed previous chunks before reinserting',
      );
    }

    const inserted = await insertDocumentChunks(
      chunks.map((chunk, index) => ({
        userId: KNOWLEDGE_BASE_OWNER_ID,
        documentId,
        scope: 'shared' as const,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        embedding: embedded[index]!.vector,
        embeddingModel: embedded[index]!.model,
        sourceName: originalName,
        ...(pageNumbers[index] ? { pageNumber: pageNumbers[index] } : {}),
      })),
    );

    if (inserted !== chunks.length) {
      throw new Error(`Stored ${inserted} chunks but produced ${chunks.length}`);
    }

    // Only now, with every chunk on disk, does the document claim to be ready.
    await updateDocumentStatusForUser(documentId, KNOWLEDGE_BASE_OWNER_ID, 'ready', {
      chunkCount: inserted,
    });

    const durationMs = Date.now() - startedAt;

    logInfo(
      {
        operation: 'rag.ingest',
        status: 'completed',
        documentId,
        chunkCount: inserted,
        embeddingModel: model.model,
        durationMs,
      },
      'Ingestion completed',
    );

    return {
      documentId,
      status: 'ready',
      originalName,
      characterCount: extracted.characterCount,
      pageCount: extracted.pageCount,
      chunkCount: inserted,
      embeddingModel: model.model,
      embeddingDimensions: model.dimensions,
      durationMs,
    };
  } catch (error) {
    const appError = toAppError(error);

    /**
     * Record the failure on the row before rethrowing anything.
     *
     * A document stuck at `embedding` because the process died tells you far
     * less than one marked `failed` with a reason. The stored message is the
     * safe one; the detailed message goes to the log only.
     */
    await updateDocumentStatusForUser(documentId, KNOWLEDGE_BASE_OWNER_ID, 'failed', {
      error: {
        code: appError.code,
        safeMessage: isAppError(error)
          ? appError.safeMessage
          : 'Ingestion failed. Check the server logs for details.',
      },
    }).catch(() => {
      // The database itself may be what failed. Losing the status update is
      // bad, but throwing here would replace a useful error with a useless one.
    });

    logError(error, { operation: 'rag.ingest', status: 'failed', documentId });

    return {
      documentId,
      status: 'failed',
      originalName,
      characterCount: 0,
      pageCount: 0,
      chunkCount: 0,
      embeddingModel: model.model,
      embeddingDimensions: model.dimensions,
      durationMs: Date.now() - startedAt,
      error: isAppError(error) ? appError.safeMessage : 'Ingestion failed.',
    };
  }
}
