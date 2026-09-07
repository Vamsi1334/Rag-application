import { createHash } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';

import { makePdf, makeScannedPdf } from '../fixtures/make-pdf';

/**
 * The ingestion pipeline, end to end.
 *
 * Real MongoDB, real PDF parsing, real chunking. Only the call to Voyage is
 * mocked, because a test that spends money and needs a production key is a test
 * nobody runs. The fake key below is asserted never to leave the request.
 *
 * ------------------------------------------------------------------
 * What these are actually protecting
 * ------------------------------------------------------------------
 * Every failure this file catches is silent in production:
 *
 *   - A document marked `ready` with no chunks answers nothing, forever, and
 *     nothing in the logs says why.
 *   - A partially embedded document answers questions from two thirds of a
 *     file and looks completely healthy.
 *   - A second run that appends instead of replacing returns the same passage
 *     twice from two generations of the same file.
 *
 * None of those throw. They all just make the product quietly wrong, which is
 * why they are asserted here rather than left to be noticed later.
 */

const DIMENSIONS = 256;
const FAKE_KEY = 'pa-test-key-not-real';

/**
 * An escape hatch for the one test that needs to hand the ingester vectors the
 * real provider would never produce.
 *
 * Null for every other test, so they exercise the genuine embedding service
 * over a mocked `fetch`. Swapping the whole module out by default would turn
 * this file from an integration test into a much weaker one.
 */
const embedOverride: {
  current: null | ((texts: string[]) => Promise<import('@/server/rag/embedding-service').EmbeddedText[]>);
} = { current: null };

vi.mock('@/server/rag/embedding-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/rag/embedding-service')>();
  return {
    ...actual,
    embedDocumentChunks: (texts: string[]) =>
      embedOverride.current ? embedOverride.current(texts) : actual.embedDocumentChunks(texts),
  };
});

let mongo: MongoMemoryServer;

type Modules = {
  ingest: typeof import('@/server/rag/ingest-document');
  documents: typeof import('@/server/db/repositories/documents.repo');
  chunks: typeof import('@/server/db/repositories/document-chunks.repo');
  collections: typeof import('@/server/db/collections');
  client: typeof import('@/server/db/client');
  indexes: typeof import('@/server/db/indexes');
  types: typeof import('@/server/db/types');
};

let mod: Modules;

const fetchMock = vi.fn();

/** A distinct vector per row, so a shuffled response would be detectable. */
function vector(seed: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, i) => (seed + i) / 10_000);
}

/** Answers the way Voyage does: one row per input, each carrying its index. */
function voyageResponse(inputCount: number, dimensions = DIMENSIONS): Response {
  return new Response(
    JSON.stringify({
      object: 'list',
      data: Array.from({ length: inputCount }, (_, index) => ({
        object: 'embedding',
        index,
        embedding: vector(index + 1).slice(0, dimensions),
      })),
      model: 'voyage-4-lite',
      usage: { total_tokens: 42 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * Replies to whatever was asked for.
 *
 * `mockResolvedValue` would hand back the same Response object every time and
 * its body can only be read once, so the second batch fails with "Body is
 * unusable". Building a fresh one per call also lets the reply match the batch
 * size, which is what makes the count assertions meaningful.
 */
function respondWithEmbeddings(dimensions = DIMENSIONS): void {
  fetchMock.mockImplementation((_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    return Promise.resolve(voyageResponse(body.input.length, dimensions));
  });
}

function proseLine(index: number): string {
  return (
    `Section ${index} explains how search intent shapes the pages that rank, ` +
    `and how answer engines choose which source to quote.`
  );
}

function pdfWithProse(lines: number): Uint8Array {
  return makePdf([{ lines: Array.from({ length: lines }, (_, i) => proseLine(i)) }]);
}

/**
 * A document long enough to need more than one embedding batch.
 *
 * Batches are bounded by estimated TOKENS, not by chunk count, so "long
 * enough" means more than `EMBEDDING_MAX_TOKENS_PER_REQUEST` worth of text.
 * At the 5,000-token budget set above, this is comfortably several requests.
 * A partial-failure test that fits in one request passes without testing
 * anything, so the assertion below checks the request count too.
 */
function longPdf(pages = 20, linesPerPage = 30): Uint8Array {
  return makePdf(
    Array.from({ length: pages }, (_, page) => ({
      lines: Array.from({ length: linesPerPage }, (_, line) => proseLine(page * linesPerPage + line)),
    })),
  );
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();

  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB_NAME = 'ingestion_test';
  // Small chunks so a modest fixture still produces several passages, which is
  // what makes ordering and partial-failure assertions worth anything.
  process.env.CHUNK_SIZE = '300';
  process.env.CHUNK_OVERLAP = '50';
  process.env.EMBEDDING_PROVIDER = 'voyage';
  process.env.EMBEDDING_DIMENSIONS = String(DIMENSIONS);
  process.env.VOYAGE_API_KEY = FAKE_KEY;
  /*
   * Rate limiting, turned down so the suite does not wait on a real clock.
   *
   * The production defaults are sized for Voyage's free trial: 3 requests per
   * minute means a 20-second gap between batches, and 4 retries on a 429 means
   * a minute of backoff. Correct there, useless here.
   *
   * 10,000 requests per minute is a six-millisecond gap, so pacing stays wired
   * up rather than switched off, and no retries means a rate limit surfaces
   * immediately, which is what the failure tests are asking about. Pacing and
   * retry behaviour itself is tested directly in the provider's own suite.
   */
  process.env.EMBEDDING_MAX_TOKENS_PER_REQUEST = '5000';
  process.env.EMBEDDING_REQUESTS_PER_MINUTE = '10000';
  process.env.EMBEDDING_TOKENS_PER_MINUTE = '100000000';
  process.env.EMBEDDING_MAX_RETRIES = '0';
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_MODEL;

  const { resetServerEnvCache } = await import('@/server/config/env');
  resetServerEnvCache();

  mod = {
    ingest: await import('@/server/rag/ingest-document'),
    documents: await import('@/server/db/repositories/documents.repo'),
    chunks: await import('@/server/db/repositories/document-chunks.repo'),
    collections: await import('@/server/db/collections'),
    client: await import('@/server/db/client'),
    indexes: await import('@/server/db/indexes'),
    types: await import('@/server/db/types'),
  };

  await mod.indexes.ensureIndexes();
}, 120_000);

afterAll(async () => {
  await mod?.client.closeMongoClient();
  await mongo?.stop();
});

beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock);
  const documents = await mod.collections.documentsCollection();
  const chunks = await mod.collections.documentChunksCollection();
  await documents.deleteMany({});
  await chunks.deleteMany({});
});

afterEach(() => {
  fetchMock.mockReset();
  embedOverride.current = null;
  vi.unstubAllGlobals();
});

describe('a document that ingests cleanly', () => {
  it('extracts, chunks, embeds and stores in one pass', async () => {
    respondWithEmbeddings();

    const result = await mod.ingest.ingestDocument({
      bytes: pdfWithProse(14),
      originalName: 'marketing-handbook.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.status).toBe('ready');
    expect(result.chunkCount).toBeGreaterThan(1);
    expect(result.characterCount).toBeGreaterThan(0);
    expect(result.embeddingDimensions).toBe(DIMENSIONS);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('stores the document metadata against the shared knowledge base owner', async () => {
    respondWithEmbeddings();

    const result = await mod.ingest.ingestDocument({
      bytes: pdfWithProse(6),
      originalName: 'marketing-handbook.pdf',
      mimeType: 'application/pdf',
    });

    const stored = await mod.documents.findDocumentForUser(
      result.documentId,
      mod.types.KNOWLEDGE_BASE_OWNER_ID,
    );

    expect(stored?.originalName).toBe('marketing-handbook.pdf');
    expect(stored?.mimeType).toBe('application/pdf');
    expect(stored?.sizeBytes).toBeGreaterThan(0);
    expect(stored?.status).toBe('ready');
    expect(stored?.chunkCount).toBe(result.chunkCount);
    /**
     * `shared`, not `user`. This document belongs to the company corpus that
     * every signed-in person can search, which is a different thing from a
     * document someone uploaded for themselves. The distinction has to be on
     * the row, because the retrieval filter in a later phase reads it.
     */
    expect(stored?.scope).toBe('shared');
    // A 64-character hex checksum of the file contents, which is what makes a
    // second run recognisable as the same document.
    expect(stored?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores every chunk with its vector, in order, tagged with the model', async () => {
    respondWithEmbeddings();

    const result = await mod.ingest.ingestDocument({
      bytes: pdfWithProse(14),
      originalName: 'marketing-handbook.pdf',
      mimeType: 'application/pdf',
    });

    const stored = await mod.chunks.listChunksForDocument(
      result.documentId,
      mod.types.KNOWLEDGE_BASE_OWNER_ID,
    );

    expect(stored).toHaveLength(result.chunkCount);
    expect(stored.map((chunk) => chunk.chunkIndex)).toEqual(stored.map((_, i) => i));

    for (const chunk of stored) {
      expect(chunk.content.trim().length).toBeGreaterThan(0);
      expect(chunk.embedding).toHaveLength(DIMENSIONS);
      expect(chunk.embeddingModel).toBe('voyage-4-lite');
      expect(chunk.scope).toBe('shared');
      // Carried so a citation can name the file without a second lookup.
      expect(chunk.sourceName).toBe('marketing-handbook.pdf');
    }
  });

  it('keeps each chunk paired with the vector that was made from it', async () => {
    /**
     * Voyage may return rows out of order, and the provider reorders them by
     * the reported index. If that ever regressed, every chunk would be stored
     * against someone else's coordinates: search would still return results,
     * they would just be the wrong passages, and nothing would error.
     *
     * Here row N always carries vector(N+1), so a shuffle is visible.
     */
    respondWithEmbeddings();

    const result = await mod.ingest.ingestDocument({
      bytes: pdfWithProse(14),
      originalName: 'marketing-handbook.pdf',
      mimeType: 'application/pdf',
    });

    const stored = await mod.chunks.listChunksForDocument(
      result.documentId,
      mod.types.KNOWLEDGE_BASE_OWNER_ID,
    );

    for (const chunk of stored) {
      expect(chunk.embedding?.[0]).toBeCloseTo(vector(chunk.chunkIndex + 1)[0]!, 10);
    }
  });

  it('sends the chunk text as documents, not as a query', async () => {
    // Voyage embeds a passage and a question differently, and the wrong value
    // degrades retrieval quietly rather than failing.
    respondWithEmbeddings();

    await mod.ingest.ingestDocument({
      bytes: pdfWithProse(6),
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      input_type: string;
      output_dimension: number;
    };

    expect(body.input_type).toBe('document');
    expect(body.output_dimension).toBe(DIMENSIONS);
  });

  it('records a page number only where the format supplies one', async () => {
    respondWithEmbeddings();

    const pdf = makePdf([
      { lines: Array.from({ length: 8 }, (_, i) => `Page one, line ${i}, about technical SEO.`) },
      { lines: Array.from({ length: 8 }, (_, i) => `Page two, line ${i}, about answer engines.`) },
    ]);

    const result = await mod.ingest.ingestDocument({
      bytes: pdf,
      originalName: 'two-pages.pdf',
      mimeType: 'application/pdf',
    });

    const stored = await mod.chunks.listChunksForDocument(
      result.documentId,
      mod.types.KNOWLEDGE_BASE_OWNER_ID,
    );

    const pages = stored.map((chunk) => chunk.pageNumber);
    expect(pages.every((page) => page === undefined || page >= 1)).toBe(true);
    expect(pages.some((page) => page !== undefined)).toBe(true);
  });

  it('stores no page number for a format that has no pages', async () => {
    // A citation pointing at an invented page is worse than one with no page:
    // it looks checkable and is not.
    respondWithEmbeddings();

    const markdown = new TextEncoder().encode(
      Array.from({ length: 20 }, (_, i) => `## Heading ${i}\n\nBody paragraph number ${i}.`).join(
        '\n\n',
      ),
    );

    const result = await mod.ingest.ingestDocument({
      bytes: markdown,
      originalName: 'notes.md',
      mimeType: 'text/markdown',
    });

    const stored = await mod.chunks.listChunksForDocument(
      result.documentId,
      mod.types.KNOWLEDGE_BASE_OWNER_ID,
    );

    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((chunk) => chunk.pageNumber === undefined)).toBe(true);
  });
});

describe('running the same file twice', () => {
  it('resumes a document abandoned partway, without needing --force', async () => {
    /**
     * A process killed during ingestion leaves a row stuck at `embedding` with
     * no chunks. Like a failure, it has nothing finished to protect, so it
     * reprocesses on the next run rather than reporting itself as done.
     */
    respondWithEmbeddings();
    const pdf = pdfWithProse(8);

    const abandoned = await mod.documents.createDocument({
      userId: mod.types.KNOWLEDGE_BASE_OWNER_ID,
      scope: 'shared',
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
      sizeBytes: pdf.byteLength,
      checksum: createHash('sha256').update(pdf).digest('hex'),
    });
    await mod.documents.updateDocumentStatusForUser(
      abandoned._id,
      mod.types.KNOWLEDGE_BASE_OWNER_ID,
      'embedding',
    );

    const result = await mod.ingest.ingestDocument({
      bytes: pdf,
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.status).toBe('ready');
    expect(result.documentId).toBe(abandoned._id.toHexString());
    expect(result.chunkCount).toBeGreaterThan(0);
  });

  it('is a no-op without --force, and does not call the API again', async () => {
    respondWithEmbeddings();
    const pdf = pdfWithProse(8);

    const first = await mod.ingest.ingestDocument({
      bytes: pdf,
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });
    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = await mod.ingest.ingestDocument({
      bytes: pdf,
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });

    expect(second.status).toBe('skipped');
    expect(second.documentId).toBe(first.documentId);
    // Not just cheaper: an accidental second run must not silently double the
    // corpus, which would return the same passage twice for every question.
    expect(fetchMock.mock.calls).toHaveLength(callsAfterFirst);
    expect(await mod.chunks.countChunksForDocument(
      first.documentId,
      mod.types.KNOWLEDGE_BASE_OWNER_ID,
    )).toBe(first.chunkCount);
  });

  it('replaces the old chunks with force, rather than adding to them', async () => {
    respondWithEmbeddings();
    const pdf = pdfWithProse(8);

    const first = await mod.ingest.ingestDocument({
      bytes: pdf,
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });

    const second = await mod.ingest.ingestDocument({
      bytes: pdf,
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
      force: true,
    });

    expect(second.status).toBe('ready');
    expect(second.documentId).toBe(first.documentId);

    const total = await mod.chunks.countChunksForDocument(
      first.documentId,
      mod.types.KNOWLEDGE_BASE_OWNER_ID,
    );

    expect(total).toBe(second.chunkCount);
    expect(total).toBe(first.chunkCount);
  });
});

describe('failure never leaves a document looking healthy', () => {
  it('marks the document failed when the embedding API is down', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const result = await mod.ingest.ingestDocument({
      bytes: pdfWithProse(8),
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.status).toBe('failed');

    const stored = await mod.documents.findDocumentForUser(
      result.documentId,
      mod.types.KNOWLEDGE_BASE_OWNER_ID,
    );

    expect(stored?.status).toBe('failed');
    expect(stored?.error?.code).toBeTruthy();
  });

  it('writes no chunks at all when embedding fails partway', async () => {
    /**
     * The reason embedding happens entirely in memory before anything is
     * written. If chunks were stored as they were embedded, a failure at chunk
     * 70 of 100 would leave a corpus that answers from two thirds of a file and
     * reports itself as healthy.
     *
     * Here the second batch fails. Nothing may be on disk.
     */
    let call = 0;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      call += 1;
      if (call === 1) {
        const body = JSON.parse(String(init.body)) as { input: string[] };
        return Promise.resolve(voyageResponse(body.input.length));
      }
      return Promise.resolve(new Response('{"detail":"rate limited"}', { status: 429 }));
    });

    const result = await mod.ingest.ingestDocument({
      bytes: longPdf(),
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });

    // More than one request, or the second batch never happened and this
    // asserts nothing.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(result.status).toBe('failed');
    expect(
      await mod.chunks.countChunksForDocument(
        result.documentId,
        mod.types.KNOWLEDGE_BASE_OWNER_ID,
      ),
    ).toBe(0);
  });

  it('refuses vectors of the wrong length instead of storing them', async () => {
    /**
     * The Atlas index declares a fixed vector length. A mismatch does not fail
     * loudly at write time: the rows land, the index quietly refuses to index
     * them, and search returns nothing for a document that looks perfectly
     * ingested. Nothing throws, so it has to be caught deliberately.
     *
     * There are two guards for this. The one exercised here is the provider's:
     * Voyage answering with 128 numbers when 256 were asked for is rejected
     * before the vectors ever reach the pipeline. The second guard, in the
     * ingester immediately before the write, is tested separately below,
     * because from this direction it is unreachable.
     */
    respondWithEmbeddings(128);

    const result = await mod.ingest.ingestDocument({
      bytes: pdfWithProse(8),
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.status).toBe('failed');
    expect(
      await mod.chunks.countChunksForDocument(
        result.documentId,
        mod.types.KNOWLEDGE_BASE_OWNER_ID,
      ),
    ).toBe(0);
  });

  it('re-checks vector length itself, in case a provider does not', async () => {
    /**
     * The ingester's own dimension check, with the embedding service replaced
     * so wrong-length vectors actually get through to it.
     *
     * Worth the trouble because the check is otherwise dead code that looks
     * tested: mutating it away leaves every other test in this file green,
     * since the Voyage provider rejects the bad response first. That is only
     * true of the provider we happen to use today. The guard exists for the
     * next one, and a guard nobody exercises is a guard nobody can trust.
     */
    embedOverride.current = async (texts: string[]) =>
      texts.map(() => ({
        vector: Array.from({ length: 128 }, () => 0.1),
        model: 'voyage-4-lite',
        // Claims 256 while carrying 128, which is the shape of the bug that
        // silently produces an unsearchable document.
        dimensions: DIMENSIONS,
      }));

    const result = await mod.ingest.ingestDocument({
      bytes: pdfWithProse(8),
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.status).toBe('failed');
    expect(
      await mod.chunks.countChunksForDocument(
        result.documentId,
        mod.types.KNOWLEDGE_BASE_OWNER_ID,
      ),
    ).toBe(0);
  });

  it('rejects a scanned PDF before spending anything on embeddings', async () => {
    respondWithEmbeddings();

    const result = await mod.ingest.ingestDocument({
      bytes: makeScannedPdf(3),
      originalName: 'scan.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.status).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();

    const stored = await mod.documents.findDocumentForUser(
      result.documentId,
      mod.types.KNOWLEDGE_BASE_OWNER_ID,
    );
    expect(stored?.status).toBe('failed');
  });

  it('gives a failure message a person can act on, with no internals in it', async () => {
    fetchMock.mockResolvedValue(new Response('{"detail":"nope"}', { status: 401 }));

    const result = await mod.ingest.ingestDocument({
      bytes: pdfWithProse(8),
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain(FAKE_KEY);
    expect(result.error).not.toContain('Bearer');
  });

  it('retries a failed document without needing --force', async () => {
    /**
     * The distinction between "already done" and "a row exists".
     *
     * A failed document has no chunk set anyone is using, so there is nothing
     * to protect by refusing to redo it. Treating it as already ingested meant
     * that re-running the exact command that just failed printed "Nothing
     * changed" and exited 0: the fix for a transient failure was
     * indistinguishable from success, and in a CI step it would have stayed
     * that way.
     */
    const pdf = pdfWithProse(8);

    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const failed = await mod.ingest.ingestDocument({
      bytes: pdf,
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });
    expect(failed.status).toBe('failed');

    fetchMock.mockReset();
    respondWithEmbeddings();

    // No `force`. The same command that failed, run again.
    const retried = await mod.ingest.ingestDocument({
      bytes: pdf,
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });

    expect(retried.status).toBe('ready');
    expect(retried.documentId).toBe(failed.documentId);

    const stored = await mod.documents.findDocumentForUser(
      retried.documentId,
      mod.types.KNOWLEDGE_BASE_OWNER_ID,
    );

    expect(stored?.status).toBe('ready');
    // The stale failure has to be cleared, or the row reads as broken forever.
    expect(stored?.error).toBeUndefined();
  });
});

describe('the credential never escapes', () => {
  it('travels in the Authorization header and nowhere else', async () => {
    respondWithEmbeddings();

    await mod.ingest.ingestDocument({
      bytes: pdfWithProse(6),
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    // A key in a URL ends up in access logs, browser history and error
    // trackers. A key in a header does not.
    expect(url).not.toContain(FAKE_KEY);
    expect(String(init.body)).not.toContain(FAKE_KEY);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it('is not written into any stored row', async () => {
    respondWithEmbeddings();

    const result = await mod.ingest.ingestDocument({
      bytes: pdfWithProse(6),
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });

    const documents = await mod.collections.documentsCollection();
    const chunks = await mod.collections.documentChunksCollection();

    const dump = JSON.stringify([
      await documents.find({}).toArray(),
      await chunks.find({}).toArray(),
    ]);

    expect(result.status).toBe('ready');
    expect(dump).not.toContain(FAKE_KEY);
  });

  it('is not returned to the caller', async () => {
    respondWithEmbeddings();

    const result = await mod.ingest.ingestDocument({
      bytes: pdfWithProse(6),
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });

    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });
});

describe('ownership of the shared corpus', () => {
  it('cannot be read by an arbitrary user id', async () => {
    /**
     * Shared documents are owned by a fixed sentinel id rather than being
     * ownerless, so every query still filters on one `userId` field. A random
     * user asking for the row by id gets nothing, which is what proves the
     * filter is doing the work rather than the id being effectively public.
     */
    respondWithEmbeddings();

    const result = await mod.ingest.ingestDocument({
      bytes: pdfWithProse(6),
      originalName: 'handbook.pdf',
      mimeType: 'application/pdf',
    });

    const stranger = new ObjectId().toHexString();

    expect(await mod.documents.findDocumentForUser(result.documentId, stranger)).toBeNull();
    expect(await mod.chunks.listChunksForDocument(result.documentId, stranger)).toEqual([]);
  });

  it('uses a stable owner id, so a later retrieval filter can name it', async () => {
    expect(mod.types.KNOWLEDGE_BASE_OWNER_ID).toBe('000000000000000000000001');
    expect(ObjectId.isValid(mod.types.KNOWLEDGE_BASE_OWNER_ID)).toBe(true);
  });
});
