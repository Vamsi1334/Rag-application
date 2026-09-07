import { describe, expect, it } from 'vitest';

import {
  VECTOR_INDEX_NAME,
  buildVectorIndexDefinition,
} from '@/server/db/vector-index';

/**
 * The vector index definition.
 *
 * This is a security test wearing a configuration test's clothes.
 *
 * `userId` declared as a filter field is what lets Atlas restrict the search
 * space BEFORE finding nearest neighbours. Remove it and the only remaining
 * way to enforce ownership is to fetch the global top matches and drop other
 * people's afterwards, which fails twice over: it silently returns fewer
 * results than requested, and one missed filter puts another user's document
 * text into a prompt.
 *
 * So the first test here is the one that would catch somebody "simplifying"
 * this definition later.
 */

describe('ownership', () => {
  const definition = buildVectorIndexDefinition(256);

  it('declares userId as a filter field', () => {
    const filters = definition.definition.fields.filter((f) => f.type === 'filter');

    expect(filters.map((f) => f.path)).toContain('userId');
  });

  it('declares documentId as a filter, so a search can be scoped to one file', () => {
    const filters = definition.definition.fields.filter((f) => f.type === 'filter');

    expect(filters.map((f) => f.path)).toContain('documentId');
  });

  it('has exactly one vector field, on the embedding path', () => {
    const vectors = definition.definition.fields.filter((f) => f.type === 'vector');

    expect(vectors).toHaveLength(1);
    expect(vectors[0]?.path).toBe('embedding');
  });
});

describe('vector configuration', () => {
  it('uses cosine similarity', () => {
    // Cosine compares direction and ignores magnitude, so a long passage and a
    // short one on the same subject score as similar. Euclidean would call
    // them far apart purely because one vector is bigger.
    const [field] = buildVectorIndexDefinition(256).definition.fields.filter(
      (f) => f.type === 'vector',
    );

    expect(field?.similarity).toBe('cosine');
  });

  it('carries the dimensions it was given, with no default of its own', () => {
    // The index dimension and the embedding model must agree exactly. Having
    // this function invent a number would be a way for them to drift apart.
    expect(
      buildVectorIndexDefinition(256).definition.fields.find((f) => f.type === 'vector')
        ?.numDimensions,
    ).toBe(256);

    expect(
      buildVectorIndexDefinition(1024).definition.fields.find((f) => f.type === 'vector')
        ?.numDimensions,
    ).toBe(1024);
  });

  it('is declared as a vectorSearch index under a stable name', () => {
    const definition = buildVectorIndexDefinition(256);

    expect(definition.type).toBe('vectorSearch');
    // The name is referenced by every $vectorSearch query. Changing it means
    // every search silently finds no index.
    expect(definition.name).toBe(VECTOR_INDEX_NAME);
  });
});
