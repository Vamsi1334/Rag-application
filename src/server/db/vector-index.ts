import 'server-only';

import { documentChunksCollection } from './collections';
import { COLLECTIONS } from './collections';
import { driverErrorName, safeDriverMessage } from './redact';
import { logInfo, logWarn } from '@/server/observability/logger';

/**
 * The Atlas Vector Search index.
 *
 * ------------------------------------------------------------------
 * Why this is not in indexes.ts with the others
 * ------------------------------------------------------------------
 * A vector index is a different kind of object. Ordinary indexes are created
 * with `createIndexes` and live inside the database; Atlas Search indexes are
 * created through a separate API, are built asynchronously, and take a while
 * to become queryable. Mixing them would mean `ensureIndexes` sometimes
 * returning before its work was usable.
 *
 * ------------------------------------------------------------------
 * The filter field is the security boundary
 * ------------------------------------------------------------------
 * `userId` is declared below as a `filter` field, and that is the single most
 * important line in this file.
 *
 * Vector search returns the N nearest vectors. Without a filter inside the
 * search, the only way to enforce ownership is to fetch the global top matches
 * and discard the ones belonging to other people afterwards. That fails in two
 * ways at once:
 *
 *   1. It silently returns fewer results than asked for. Request 5, get the
 *      global top 5, discard 4 that belong to other users, answer from 1.
 *      Retrieval quality collapses and nothing reports an error.
 *
 *   2. One missed filter and another user's document text goes into the
 *      prompt, and from there into an answer. That is the exact failure this
 *      whole application is built to make impossible.
 *
 * Declared as a filter, Atlas restricts the search space before finding
 * nearest neighbours. You get the top 5 OF THAT USER'S chunks, which is both
 * correct and better.
 *
 * ------------------------------------------------------------------
 * Why cosine
 * ------------------------------------------------------------------
 * Cosine similarity compares direction and ignores magnitude, so a long
 * passage and a short one about the same subject score as similar. Euclidean
 * distance would treat them as far apart because one vector is simply bigger.
 * For text retrieval, meaning is direction.
 */

export const VECTOR_INDEX_NAME = 'chunk_embedding_vector_index';

export interface VectorIndexDefinition {
  name: string;
  type: 'vectorSearch';
  definition: {
    fields: (
      | { type: 'vector'; path: string; numDimensions: number; similarity: 'cosine' }
      | { type: 'filter'; path: string }
    )[];
  };
}

/**
 * Builds the index definition for a given vector length.
 *
 * Takes dimensions as an argument rather than reading configuration, so the
 * definition can be asserted in a test without an environment, and so the one
 * value that must match the embedding model is passed in explicitly by the
 * caller that knows it.
 */
export function buildVectorIndexDefinition(dimensions: number): VectorIndexDefinition {
  return {
    name: VECTOR_INDEX_NAME,
    type: 'vectorSearch',
    definition: {
      fields: [
        {
          type: 'vector',
          path: 'embedding',
          numDimensions: dimensions,
          similarity: 'cosine',
        },
        // Ownership. Not optional, not an optimisation. See the file comment.
        { type: 'filter', path: 'userId' },
        // Lets a search be scoped to chosen documents, for "ask this file"
        // rather than "ask everything I have uploaded".
        { type: 'filter', path: 'documentId' },
      ],
    },
  };
}

export interface VectorIndexResult {
  status: 'created' | 'exists' | 'unsupported';
  name: string;
  detail: string;
}

/**
 * Creates the vector index if the cluster supports doing so programmatically.
 *
 * Atlas exposes search index management through the driver on recent clusters.
 * Where it is not available, this reports `unsupported` rather than throwing,
 * and the caller falls back to the printed JSON for the Atlas UI. A missing
 * vector index is a real problem, but it is a deployment problem, and it
 * should not take the process down.
 */
export async function ensureVectorIndex(dimensions: number): Promise<VectorIndexResult> {
  const definition = buildVectorIndexDefinition(dimensions);
  const collection = await documentChunksCollection();

  try {
    const existing = await collection.listSearchIndexes().toArray();
    const found = existing.find((index) => index.name === VECTOR_INDEX_NAME);

    if (found) {
      logInfo(
        { operation: 'db.vectorIndex', status: 'exists', indexName: VECTOR_INDEX_NAME },
        'Vector index already present',
      );
      return {
        status: 'exists',
        name: VECTOR_INDEX_NAME,
        detail:
          'Index already exists. Atlas does not allow changing dimensions in place: ' +
          'to change them, drop it, recreate it and re-embed every chunk.',
      };
    }

    await collection.createSearchIndex(definition);

    logInfo(
      {
        operation: 'db.vectorIndex',
        status: 'created',
        indexName: VECTOR_INDEX_NAME,
        embeddingDimensions: dimensions,
      },
      'Vector index creation started',
    );

    return {
      status: 'created',
      name: VECTOR_INDEX_NAME,
      detail: 'Creation started. Atlas builds it asynchronously; it is queryable once READY.',
    };
  } catch (error) {
    logWarn(
      {
        operation: 'db.vectorIndex',
        status: 'unsupported',
        errorType: driverErrorName(error),
      },
      `Could not create the vector index programmatically: ${safeDriverMessage(error)}`,
    );

    return {
      status: 'unsupported',
      name: VECTOR_INDEX_NAME,
      detail:
        'Programmatic creation is unavailable on this cluster. Create it in the Atlas UI ' +
        `using the JSON from buildVectorIndexDefinition(${dimensions}), on ` +
        `the "${COLLECTIONS.documentChunks}" collection.`,
    };
  }
}
