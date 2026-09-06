# Ingestion

Turning an uploaded file into searchable chunks:

    extract -> clean -> chunk -> embed -> store

**Phases 5 and 6.** Empty by design.

Planned files:
- `pipeline.ts` — the resumable state machine that advances a document one step
  at a time, so a large file never has to finish inside one request
- `extract/` — one extractor per format, all returning the same shape
- `clean.ts` — strips repeated headers, footers and page numbers before chunking
- `chunk.ts` — structure-aware splitting with overlap and citation metadata
