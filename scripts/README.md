# Scripts

Operational tasks that need to be reproducible rather than clicked through a
dashboard.

Planned:
- `create-vector-index.ts` — the search index is schema, so it belongs in the
  repository and runs per environment
- `reindex-embeddings.ts` — the migration path for changing embedding model
- `run-eval.ts` — scores retrieval and answer quality against a fixed question set
