import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';

import {
  buildVectorSearchPipeline,
  mapVectorSearchError,
} from '@/server/db/repositories/document-chunks.repo';
import { ConfigurationError } from '@/server/observability/errors';
import { KNOWLEDGE_BASE_OWNER_ID } from '@/server/db/types';
import { VECTOR_INDEX_NAME } from '@/server/db/vector-index';

/**
 * The ownership filter inside the vector search.
 *
 * ===================================================================
 * WHY THIS FILE EXISTS AT ALL
 * ===================================================================
 * `$vectorSearch` runs inside Atlas Search, a separate process from mongod
 * that the in-memory MongoDB used by the integration tests does not have. So
 * the security boundary of this entire application, the filter deciding whose
 * passages a question can reach, cannot be tested by running a query anywhere
 * except against a live Atlas cluster.
 *
 * That is why the pipeline is built by a pure function. Everything below
 * asserts the shape of the query that WILL be sent, which is the next best
 * thing to running it and is available in a millisecond on every commit.
 *
 * The failure being guarded against is not subtle in its consequences and is
 * completely silent in its symptoms: a filter in the wrong place returns the
 * global nearest passages, and another user's document text ends up in a
 * prompt and then in an answer.
 * ===================================================================
 */

const user = new ObjectId().toHexString();
const vector = Array.from({ length: 256 }, (_, i) => i / 1000);

function pipeline(userId: string = user, options = { limit: 5 }) {
  return buildVectorSearchPipeline(vector, userId, options);
}

function vectorSearchStage(stages: Record<string, unknown>[]) {
  return stages[0]?.$vectorSearch as {
    index: string;
    path: string;
    queryVector: number[];
    numCandidates: number;
    limit: number;
    filter: Record<string, unknown>;
  };
}

describe('the filter is inside the search', () => {
  it('puts the ownership filter in the $vectorSearch stage itself', () => {
    /**
     * The single most important assertion in this codebase.
     *
     * A `$match` on a later stage would look equivalent to a reviewer and be a
     * serious bug. Atlas would find the global nearest neighbours across every
     * user's chunks, and only afterwards would other people's rows be thrown
     * away. Two things then go wrong at once: you asked for five passages and
     * get one, so answers quietly get worse; and the moment that later stage
     * is edited wrongly, another user's text reaches the prompt.
     */
    const stage = vectorSearchStage(pipeline());

    expect(stage.filter).toBeDefined();
    expect(stage.filter.userId).toEqual({
      $in: [new ObjectId(user), new ObjectId(KNOWLEDGE_BASE_OWNER_ID)],
    });
  });

  it('has no $match stage doing ownership work after the search', () => {
    const stages = pipeline();
    const matchStages = stages.filter((stage) => '$match' in stage);

    // If this ever fails, the question to answer before changing it is whether
    // the filter moved out of the search, because that is what it would mean.
    expect(matchStages).toEqual([]);
  });

  it('runs the vector search first, as Atlas requires', () => {
    const stages = pipeline();

    expect(Object.keys(stages[0]!)).toEqual(['$vectorSearch']);
  });
});

describe('who the search can see', () => {
  it('sees the caller and the shared knowledge base, and nobody else', () => {
    const stage = vectorSearchStage(pipeline());
    const allowed = (stage.filter.userId as { $in: ObjectId[] }).$in;

    expect(allowed).toHaveLength(2);
    expect(allowed.map((id) => id.toHexString())).toEqual([user, KNOWLEDGE_BASE_OWNER_ID]);
  });

  it('never includes another user, even one who owns matching passages', () => {
    const stranger = new ObjectId().toHexString();
    const stage = vectorSearchStage(pipeline());
    const allowed = (stage.filter.userId as { $in: ObjectId[] }).$in;

    expect(allowed.map((id) => id.toHexString())).not.toContain(stranger);
  });

  it('gives two different users two different filters', () => {
    // Guards against the filter being built from anything other than the id
    // passed in, such as a cached or module-level value.
    const other = new ObjectId().toHexString();

    const mine = (vectorSearchStage(pipeline()).filter.userId as { $in: ObjectId[] }).$in;
    const theirs = (vectorSearchStage(pipeline(other)).filter.userId as { $in: ObjectId[] }).$in;

    expect(mine[0]!.toHexString()).toBe(user);
    expect(theirs[0]!.toHexString()).toBe(other);
  });

  it('rejects a userId that is a query operator rather than an id', () => {
    /**
     * `{"userId": {"$ne": null}}` reaching this filter would match every chunk
     * in the collection, which is every user's document text. The id goes
     * through `toObjectId` for exactly this reason, and it throws rather than
     * building a pipeline that would run.
     */
    expect(() => pipeline({ $ne: null } as unknown as string)).toThrow();
  });

  it('rejects a malformed userId outright', () => {
    expect(() => pipeline('not-an-object-id')).toThrow();
  });
});

describe('search parameters', () => {
  it('names the index the ingestion phase created', () => {
    // A typo here returns zero results with no error, which reads as an empty
    // corpus rather than a wrong index name.
    const stage = vectorSearchStage(pipeline());

    expect(stage.index).toBe(VECTOR_INDEX_NAME);
    expect(stage.path).toBe('embedding');
  });

  it('considers far more candidates than it returns', () => {
    /**
     * Vector search is approximate. It narrows to a candidate pool and ranks
     * that, so a pool barely larger than the limit returns the nearest of
     * whatever it happened to look at rather than the nearest that exist.
     *
     * The failure is invisible: you get five results either way, they are just
     * quietly worse.
     */
    const stage = vectorSearchStage(pipeline(user, { limit: 5 }));

    expect(stage.limit).toBe(5);
    expect(stage.numCandidates).toBeGreaterThanOrEqual(50);
  });

  it('clamps a limit rather than trusting it', () => {
    // An unbounded limit is a way to pull the whole collection into memory.
    const huge = vectorSearchStage(pipeline(user, { limit: 100_000 }));
    const zero = vectorSearchStage(pipeline(user, { limit: 0 }));

    expect(huge.limit).toBeLessThanOrEqual(100);
    expect(zero.limit).toBeGreaterThanOrEqual(1);
  });

  it('keeps numCandidates inside the ceiling Atlas allows', () => {
    const stage = vectorSearchStage(pipeline(user, { limit: 100 }));

    expect(stage.numCandidates).toBeLessThanOrEqual(10_000);
  });
});

describe('what comes back', () => {
  it('does not return the embedding vector', () => {
    /**
     * 256 numbers per passage that nothing downstream reads. Left in, they
     * would travel through retrieval and context assembly and, in a careless
     * moment, into an API response, which is a kilobyte of noise per passage
     * and an invitation to leak the shape of the index.
     */
    const project = pipeline()[1]?.$project as Record<string, unknown>;

    expect(project.embedding).toBeUndefined();
    expect(project.content).toBe(1);
    expect(project.pageNumber).toBe(1);
    expect(project.sourceName).toBe(1);
  });

  it('returns the similarity score, so a weak match is visible', () => {
    const project = pipeline()[1]?.$project as Record<string, unknown>;

    expect(project.score).toEqual({ $meta: 'vectorSearchScore' });
  });
});

describe('restricting to one document', () => {
  it('adds documentId to the same filter, not a later stage', () => {
    const documentId = new ObjectId().toHexString();
    const stage = vectorSearchStage(pipeline(user, { limit: 5, documentId } as never));

    expect(stage.filter.documentId).toEqual(new ObjectId(documentId));
    // Narrowing to a document must never widen who can be seen.
    expect(stage.filter.userId).toBeDefined();
  });

  it('leaves documentId out entirely when not asked for', () => {
    const stage = vectorSearchStage(pipeline());

    expect('documentId' in stage.filter).toBe(false);
  });
});

describe('when the search cannot run', () => {
  /**
   * Two failures here are states a person can fix in minutes, and both used to
   * arrive as a bare 500 saying "Something went wrong on our end". That reads
   * as a broken product, and the real reason sat in a log nobody thought to
   * open.
   *
   * Found by running the route against a database with no Atlas Search, which
   * is exactly what a local mongod and a CI container are.
   */
  it('explains a deployment with no Atlas Search', () => {
    const error = mapVectorSearchError(
      new Error(
        'Using $search and $vectorSearch aggregation stages requires additional ' +
          'configuration. Please connect to Atlas or an AtlasCLI local deployment to enable.',
      ),
    );

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).safeMessage).toMatch(/search index is missing/i);
    expect((error as ConfigurationError).safeMessage).not.toMatch(/Something went wrong/);
  });

  it('explains an index that is missing or still building', () => {
    // Atlas builds search indexes asynchronously, so a freshly created one is
    // genuinely absent for a while, and a typo in its name looks identical.
    const error = mapVectorSearchError(new Error('PlanExecutor error: index not found'));

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).safeMessage).toMatch(/still building/i);
  });

  it('keeps the index name for the log and out of the message', () => {
    const error = mapVectorSearchError(new Error('index not found')) as ConfigurationError;

    expect(error.logMeta.indexName).toBe(VECTOR_INDEX_NAME);
    expect(error.safeMessage).not.toContain(VECTOR_INDEX_NAME);
  });

  it('leaves an unrelated failure alone', () => {
    /**
     * Only the two known, fixable states are reinterpreted. A genuine bug
     * dressed up as a configuration problem would send someone to check an
     * index that was fine all along.
     */
    const original = new Error('connection reset by peer');
    const error = mapVectorSearchError(original);

    expect(error).toBe(original);
    expect(error).not.toBeInstanceOf(ConfigurationError);
  });

  it('does not let a connection string reach the message', () => {
    // The driver puts the connection string into several of its own error
    // messages, which is one of the most common ways a production password
    // leaks. Everything here goes through the redaction helper first.
    const error = mapVectorSearchError(
      new Error('index not found on mongodb+srv://admin:hunter2@cluster0.example.net'),
    ) as ConfigurationError;

    expect(error.safeMessage).not.toContain('hunter2');
    expect(error.message).not.toContain('hunter2');
  });
});
