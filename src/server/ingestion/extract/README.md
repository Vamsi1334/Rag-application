# Extractors

`pdf.ts`, `docx.ts`, `text.ts`, and later `ocr.ts`.

Every extractor returns `{ text, pages[] }` so the rest of the pipeline never
knows or cares what the original format was.
