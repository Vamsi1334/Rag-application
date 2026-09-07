import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The absence of an upload feature, asserted.
 *
 * ------------------------------------------------------------------
 * Why a test about code that does not exist
 * ------------------------------------------------------------------
 * In this version the application serves ONE shared company knowledge base,
 * curated by whoever runs the project. A signed-in user asks questions. Nobody
 * uploads anything.
 *
 * That is enforced by there being no route to call. Which is a strong boundary
 * and a fragile one: it survives exactly until someone adds
 * `src/app/api/documents/upload/route.ts` in a hurry, at which point every
 * signed-in user can write to the shared corpus and the review that would have
 * caught it was a diff nobody looked at closely.
 *
 * So the boundary is written down as an assertion. These tests fail the moment
 * ingestion becomes reachable over HTTP, which is the moment someone should be
 * deciding about roles and authorization rather than discovering later that
 * they skipped it.
 *
 * None of this says an upload feature is wrong. It says it is a decision, not
 * an accident.
 */

const APP_DIR = new URL('../../src/app/', import.meta.url).pathname;
const SRC_DIR = new URL('../../src/', import.meta.url).pathname;

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const full = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(full) : [full];
    }),
  );
  return found.flat();
}

async function routeHandlers(): Promise<string[]> {
  const files = await filesUnder(APP_DIR);
  return files.filter((file) => /(^|\/)route\.tsx?$/.test(file));
}

describe('ingestion is not reachable over HTTP', () => {
  it('has no route that imports the ingestion pipeline', async () => {
    const offenders: string[] = [];

    for (const file of await routeHandlers()) {
      const source = await readFile(file, 'utf8');
      if (/rag\/(ingest-document|extract-text)/.test(source)) {
        offenders.push(relative(SRC_DIR, file));
      }
    }

    /**
     * If this fails, the question to answer before deleting the assertion is:
     * who is allowed to call it, and where is that checked? Ingestion writes to
     * a corpus every user reads from, so an unguarded route lets any signed-in
     * account change what the assistant tells everybody else.
     */
    expect(offenders).toEqual([]);
  });

  it('has no route that accepts a file upload', async () => {
    const offenders: string[] = [];

    for (const file of await routeHandlers()) {
      const source = await readFile(file, 'utf8');
      // The three ways a Next.js route handler takes a file.
      if (/formData\(\)|multipart\/form-data|request\.blob\(/.test(source)) {
        offenders.push(relative(SRC_DIR, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('exposes only the routes this phase is meant to have', async () => {
    const routes = (await routeHandlers())
      .map((file) => relative(APP_DIR, file).replace(/\/route\.tsx?$/, ''))
      .sort();

    /**
     * A whitelist rather than a "no upload route" check, because the next
     * person to add an ingestion endpoint will not call it "upload".
     *
     * `api/ai/ask` was added in the retrieval phase and READS the corpus. It
     * embeds a question, searches, and answers. It cannot create, replace or
     * delete a document, which is what keeps the guarantee in this file intact:
     * a signed-in user can query the shared knowledge base and still cannot
     * change what it says.
     */
    expect(routes).toEqual([
      'api/ai/ask',
      'api/ai/chat',
      'api/auth/[...nextauth]',
      'api/auth/me',
      'api/health',
      'api/health/db',
    ]);
  });

  it('has no route that writes to the corpus', async () => {
    /**
     * The read/write line, asserted separately from the route list.
     *
     * Retrieval gave the application its first route that touches
     * `document_chunks`, so "no route imports the pipeline" is no longer the
     * whole story. What matters now is that no route can call anything that
     * inserts, replaces or deletes.
     */
    const writers = /insertDocumentChunks|deleteChunksForDocument|createDocument|updateDocumentStatusForUser|softDeleteDocument/;
    const offenders: string[] = [];

    for (const file of await routeHandlers()) {
      const source = await readFile(file, 'utf8');
      if (writers.test(source)) offenders.push(relative(SRC_DIR, file));
    }

    expect(offenders).toEqual([]);
  });

  it('has no page that renders an upload control', async () => {
    const pages = (await filesUnder(APP_DIR)).filter((file) => /page\.tsx?$/.test(file));
    const offenders: string[] = [];

    for (const file of pages) {
      const source = await readFile(file, 'utf8');
      if (/type=["']file["']|<input[^>]*file/i.test(source)) {
        offenders.push(relative(SRC_DIR, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('the ingestion modules stay server-side', () => {
  it('guards every RAG module that reaches configuration, credentials or storage', async () => {
    /**
     * `server-only` throws at build time if the module is ever pulled into a
     * client bundle. These files reach the embedding key and the raw text of
     * company documents, so the build failing is the correct outcome, and far
     * better than finding out from a bundle analyser.
     *
     * `chunking.ts` is deliberately exempt. It is pure string handling with no
     * imports at all: it receives text as an argument and never sources it, so
     * there is nothing in it to leak. Marking it server-only would rule out a
     * client-side chunk preview later for no security gain. The next test is
     * what keeps that exemption honest.
     */
    const ragDir = new URL('../../src/server/rag/', import.meta.url).pathname;
    const modules = (await filesUnder(ragDir)).filter((file) => file.endsWith('.ts'));
    const exempt = new Set(['chunking.ts']);

    expect(modules.length).toBeGreaterThan(0);

    for (const file of modules) {
      if (exempt.has(relative(ragDir, file))) continue;
      const source = await readFile(file, 'utf8');
      expect(source, `${relative(SRC_DIR, file)} is missing the server-only guard`).toMatch(
        /^import 'server-only';/m,
      );
    }
  });

  it('keeps the exempt module pure, so its exemption stays true', async () => {
    // The moment chunking imports configuration, a provider or the database,
    // it stops being safe to ship to a browser and this fails, which is the
    // signal to add the guard rather than to widen the exemption.
    const source = await readFile(join(SRC_DIR, 'server/rag/chunking.ts'), 'utf8');

    expect(source).not.toMatch(/^import .* from ['"]@\/server\/(config|ai|db|auth)/m);
    expect(source).not.toMatch(/process\.env/);
  });

  it('keeps the ingestion entry point out of the application code', async () => {
    /**
     * Only the CLI script may call `ingestDocument`. Anything under `src/app`
     * or `src/components` importing it would mean a request path can reach it,
     * which is the same failure as adding a route.
     */
    const appAndUi = [
      ...(await filesUnder(APP_DIR)),
      ...(await filesUnder(new URL('../../src/components/', import.meta.url).pathname)),
    ].filter((file) => /\.tsx?$/.test(file));

    const offenders: string[] = [];
    for (const file of appAndUi) {
      const source = await readFile(file, 'utf8');
      if (/ingestDocument/.test(source)) offenders.push(relative(SRC_DIR, file));
    }

    expect(offenders).toEqual([]);
  });
});
