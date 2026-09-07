# RAG

Both halves of retrieval-augmented generation live here, because they are the
same machinery pointed in two directions.

**Ingestion** (phases 5 and 6, done):

    extract -> clean -> chunk -> embed -> store

**Retrieval** (phase 7 done; 8 and 9 next):

    rewrite -> embed query -> vector search -> select -> build context -> generate -> verify citations

They share `chunking.ts` and `embedding-service.ts`, and the second half is
only correct if it embeds queries with the same model that embedded the
passages. Splitting them across two folders would have put that constraint on
opposite sides of the codebase from each other.

## Here now

- **`extract-text.ts`** — the only file that cares what format a file is in.
  Everything after it works on a string, so adding DOCX later is one branch
  here and no change anywhere else. Refuses a document with no extractable
  text, which is what a scanned PDF is.
- **`chunking.ts`** — `cleanText`, `estimateTokens`, `chunkText`. Pure string
  handling with no imports at all, which is why it is the one module here
  without a `server-only` guard: there is nothing in it to leak. A test
  enforces that it stays that way.
- **`embedding-service.ts`** — the application's view of embedding. Knows the
  rules that hold regardless of vendor: which model produced a vector, that
  dimensions match what the index expects, and what may be logged. The pipeline
  never imports a provider directly.
- **`ingest-document.ts`** — sequences the pipeline for one file and owns what
  happens when a step fails. Called only by `scripts/ingest-document.ts`;
  a test asserts no route, page or component can reach it.
- **`retrieve.ts`** — embeds the question as a QUERY (ingestion embedded
  passages as DOCUMENTS, and the two are designed to line up) and searches. The
  ownership filter itself lives in the repository, inside the `$vectorSearch`
  stage, because that is where it has to be.
- **`build-context.ts`** — fits the passages inside the token budget, dropping
  the lowest-ranked rather than letting them crowd out the room the answer
  needs.
- **`prompts.ts`** — every prompt in one file, so a prompt change is a small
  reviewable diff rather than a line buried in a change that also touches
  routing. The grounding rules live here.
- **`answer.ts`** — sequences retrieve, assemble, generate. Skips the model
  entirely when nothing matched.

## Planned

- `citations.ts` — parsing the [1] markers and verifying each against what was
  actually retrieved, so a citation the model invented is caught rather than
  displayed
- thresholds, deduplication and hybrid search, in `retrieve.ts`
