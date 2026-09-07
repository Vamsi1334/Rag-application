# Scripts

Operational tasks that need to be reproducible rather than clicked through a
dashboard.

Every script starts with `import './bootstrap'`, which does two things a
standalone `tsx` process needs and Next.js normally handles:

1. Loads `.env.local` through `@next/env`, so a script reads the same
   configuration the dev server does.
2. Stubs the `server-only` package, which throws by design outside a React
   Server Component and would otherwise make every server module unimportable
   here.

Because bootstrap works by side effect, the modules after it are loaded with
`await import(...)`. Static imports are hoisted above it and would run first,
which is the bug this arrangement exists to avoid.

## Available

- **`create-vector-index.ts`** — the Atlas vector index. Search indexes use a
  separate API from ordinary indexes and build asynchronously, so they are not
  created by `ensureIndexes`. Safe to run repeatedly; prints the JSON for the
  Atlas UI if the cluster does not allow programmatic creation.

- **`ingest-document.ts`** — puts one document into the shared company
  knowledge base: extract, clean, chunk, embed, store.

  ```bash
  npx tsx scripts/ingest-document.ts ./docs/handbook.pdf
  npx tsx scripts/ingest-document.ts ./docs/handbook.pdf --force
  ```

  This is the **only** way a document enters the corpus. There is no upload
  route and no upload UI, so authorization is possession of the server's own
  credentials rather than a role check on an endpoint. See the "Document
  ingestion" section of the main README for why.

  Re-running on the same file is a no-op: the document is identified by a hash
  of its contents. `--force` re-extracts and replaces its chunks, which is what
  you want after changing `CHUNK_SIZE` or the embedding model.

## Planned

- `reindex-embeddings.ts` — the migration path for changing embedding model
- `run-eval.ts` — scores retrieval and answer quality against a fixed question set

## A note on output

These print counts, timings, model names and document ids. They deliberately
never print a key, a connection string, or the contents of a document, and the
failure path prints no stack trace: driver and parser errors carry both
connection strings and fragments of document text, and this output ends up in
terminals and CI logs.
