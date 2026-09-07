# Ingestion

**This folder is empty and stays empty. The code lives in `../rag/`.**

The original plan put ingestion here and retrieval in `rag/`. Building it in
phase 6 showed why that split was wrong: the two halves share `chunking.ts` and
`embedding-service.ts`, and retrieval is only correct if it embeds a question
with the same model that embedded the passages. Two folders would have put that
constraint on opposite sides of the codebase from itself.

So `extract -> clean -> chunk -> embed -> store` is in `../rag/`, alongside the
retrieval half it has to agree with. See `../rag/README.md`.

Kept rather than deleted so that a link or a note pointing here still lands
somewhere that explains the move.
