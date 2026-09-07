/**
 * Creates the Atlas Vector Search index.
 *
 * Run once per environment, and again after any change to
 * EMBEDDING_DIMENSIONS or the embedding model:
 *
 *   npx tsx scripts/create-vector-index.ts
 *
 * The index is schema, so it belongs in the repository rather than in
 * somebody's browser history. Where a cluster does not allow creating it
 * through the driver, this prints the exact JSON to paste into the Atlas UI,
 * so the definition still has one source of truth.
 *
 * Safe to run repeatedly: an existing index is reported, not replaced.
 *
 * ------------------------------------------------------------------
 * Note on the import style below
 * ------------------------------------------------------------------
 * `./bootstrap` comes first and everything else is a dynamic `await import`.
 * That ordering is load-bearing, not stylistic.
 *
 * Server modules begin with `import 'server-only'`, which throws outside
 * Next.js. Bootstrap defuses it for this process. Static imports are hoisted
 * above bootstrap's side effect, so they would run first and the guard would
 * fire before anything else happened. Dynamic imports evaluate in order.
 */

import './bootstrap';

async function main(): Promise<void> {
  const { getEmbeddingModelInfo } = await import('../src/server/rag/embedding-service');
  const { COLLECTIONS } = await import('../src/server/db/collections');
  const { buildVectorIndexDefinition, ensureVectorIndex } = await import(
    '../src/server/db/vector-index'
  );

  const info = getEmbeddingModelInfo();

  console.log('Embedding configuration');
  console.log(`  provider    ${info.provider}`);
  console.log(`  model       ${info.model}`);
  console.log(`  dimensions  ${info.dimensions}`);
  console.log('');
  console.log(`Collection    ${COLLECTIONS.documentChunks}`);
  console.log('');

  const result = await ensureVectorIndex(info.dimensions);

  console.log(`Result: ${result.status}`);
  console.log(`  ${result.detail}`);

  if (result.status === 'unsupported') {
    console.log('');
    console.log('Paste this into Atlas, Search, Create Search Index, JSON Editor:');
    console.log('');
    console.log(JSON.stringify(buildVectorIndexDefinition(info.dimensions), null, 2));
  }

  console.log('');
  console.log(
    'Reminder: the dimensions above must match the model that embedded your chunks. ' +
      'Mixing models in one index returns scores that look valid and are meaningless.',
  );
}

main()
  .catch((error: unknown) => {
    // No stack dump: driver errors can carry the connection string, and this
    // runs in terminals and CI logs.
    console.error('Failed to create the vector index.');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closeMongoClient } = await import('../src/server/db/client');
    await closeMongoClient();
  });
