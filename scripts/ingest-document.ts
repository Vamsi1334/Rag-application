/**
 * Ingests one company document into the shared knowledge base.
 *
 * ADMINISTRATIVE OPERATION. Run by whoever operates this project, from a
 * terminal, against the configured database.
 *
 *   npx tsx scripts/ingest-document.ts ./docs/company-handbook.pdf
 *   npx tsx scripts/ingest-document.ts ./docs/handbook.pdf --force
 *
 * ------------------------------------------------------------------
 * Why a script and not an admin API route
 * ------------------------------------------------------------------
 * A route would need a role system, an authorization check on every request,
 * and an endpoint that exists on the public internet for someone to probe. All
 * of that is machinery whose only job is to keep people out of a feature that
 * does not need to be online at all.
 *
 * A script has no endpoint, no session to forge and no permission check to get
 * wrong. Authorization is possession of the server's own credentials, which is
 * strictly stronger than any role check layered on top of them.
 *
 * Normal users never get an upload feature in this version. They sign in and
 * ask questions of one curated knowledge base.
 *
 * ------------------------------------------------------------------
 * Supported formats
 * ------------------------------------------------------------------
 *   .pdf   text-based only. A scanned PDF is rejected with a clear message,
 *          because it contains images of text and no text. OCR is a later
 *          phase.
 *   .md    Markdown
 *   .txt   plain text
 *
 * Re-running on the same file is a no-op ONCE IT HAS SUCCEEDED: the document is
 * recognised by a hash of its contents. Pass --force to re-extract and replace
 * its chunks, which is what you want after changing the chunk size or the
 * embedding model.
 *
 * A document that failed, or that was interrupted partway, is retried
 * automatically with no flag. There is nothing finished to protect, and having
 * to remember --force to retry a failure is how "I fixed the key and re-ran it"
 * turns into "it says nothing changed".
 */

import './bootstrap';

import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

function usage(): never {
  console.error('Usage: npx tsx scripts/ingest-document.ts <file> [--force]');
  console.error('');
  console.error('  <file>   a .pdf, .md or .txt document');
  console.error('  --force  re-ingest a document already present, replacing its chunks');
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const target = args.find((arg) => !arg.startsWith('--'));

  if (!target) usage();

  const path = resolve(target);
  const info = await stat(path).catch(() => null);

  if (!info?.isFile()) {
    console.error(`Not a file: ${path}`);
    process.exit(1);
  }

  const { mimeTypeFromFilename, SUPPORTED_MIME_TYPES } = await import(
    '../src/server/rag/extract-text'
  );
  const originalName = basename(path);
  const mimeType = mimeTypeFromFilename(originalName);

  if (!mimeType) {
    console.error(`Unsupported file type: ${originalName}`);
    console.error(`Supported: ${SUPPORTED_MIME_TYPES.join(', ')} (.pdf, .md, .txt)`);
    process.exit(1);
  }

  const { getEmbeddingModelInfo, getChunkingOptions } = await import(
    '../src/server/rag/embedding-service'
  );
  const model = getEmbeddingModelInfo();
  const chunking = getChunkingOptions();

  console.log('Ingesting into the shared knowledge base');
  console.log(`  file        ${originalName}`);
  console.log(`  type        ${mimeType}`);
  console.log(`  size        ${(info.size / 1024).toFixed(1)} KB`);
  console.log(`  provider    ${model.provider}`);
  console.log(`  model       ${model.model}`);
  console.log(`  dimensions  ${model.dimensions}`);
  console.log(`  chunk size  ${chunking.chunkSize} chars, ${chunking.overlap} overlap`);
  console.log(`  force       ${force}`);
  console.log('');

  const { ingestDocument } = await import('../src/server/rag/ingest-document');
  const bytes = new Uint8Array(await readFile(path));

  const result = await ingestDocument({ bytes, originalName, mimeType, force });

  console.log('');
  switch (result.status) {
    case 'ready':
      console.log('Ingestion complete.');
      console.log(`  documentId  ${result.documentId}`);
      console.log(`  characters  ${result.characterCount}`);
      console.log(`  pages       ${result.pageCount || 'n/a'}`);
      console.log(`  chunks      ${result.chunkCount}`);
      console.log(`  took        ${(result.durationMs / 1000).toFixed(1)}s`);
      break;

    case 'skipped':
      console.log('Already ingested and complete. Nothing changed.');
      console.log(`  documentId  ${result.documentId}`);
      console.log(`  chunks      ${result.chunkCount}`);
      console.log('');
      console.log('Pass --force to re-extract and replace its chunks,');
      console.log('which is what you want after changing CHUNK_SIZE or the embedding model.');
      break;

    case 'failed':
      console.error('Ingestion failed.');
      console.error(`  documentId  ${result.documentId}`);
      console.error(`  reason      ${result.error ?? 'unknown'}`);
      console.error('');
      console.error('The document is marked "failed" in MongoDB, not "ready".');
      console.error('Full detail is in the log lines above; nothing secret is printed.');
      process.exitCode = 1;
      break;
  }
}

main()
  .catch((error: unknown) => {
    // No stack: driver and parser errors can carry connection strings and
    // fragments of document content, and this runs in terminals and CI logs.
    console.error('Ingestion could not run.');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closeMongoClient } = await import('../src/server/db/client');
    await closeMongoClient();
  });
