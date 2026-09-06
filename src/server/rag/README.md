# RAG

Question in, grounded answer out:

    rewrite -> embed query -> vector search -> select -> build context -> generate -> verify citations

**Phases 5 and 7 to 9.** Empty by design.

Planned files:
- `retrieve.ts` — query embedding, vector search, thresholds, deduplication
- `build-context.ts` — fits the retrieved passages inside the token budget
- `prompts.ts` — every prompt template, versioned in one file so changes diff
- `citations.ts` — marker injection, parsing, and verification against what was
  actually retrieved
- `answer.ts` — the orchestrator
