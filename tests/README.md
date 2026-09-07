# Tests

- `unit/` — pure functions, no I/O, milliseconds
- `integration/` — real database, repositories, tenant isolation, the ingestion
  pipeline end to end
- `e2e/` — full browser flows (phase 14)
- `fixtures/` — real documents, built in memory rather than committed
- `stubs/` — `server-only` shim, so server modules are importable here

Run with `npm test`.

## What is real and what is mocked

Real: MongoDB (in-memory, started per file), PDF parsing, chunking, every
repository, every index and validation rule.

Mocked: `fetch`, and only `fetch`. Nothing here needs a production key, spends
money, or reaches the internet. The fake key in the ingestion tests is asserted
never to leave the Authorization header.

The rule behind that split: mock the vendor, not our own code. A test that
mocks the database happily confirms whatever the code believes about itself,
and the failures worth catching here, an ownership filter that does not exclude
and a unique index that does not fire, are exactly the ones a mock cannot see.

## Fixtures

`fixtures/make-pdf.ts` builds genuine PDFs byte by byte, with a correct
cross-reference table, and pdf.js reads them the same way it reads a file from
Acrobat. Committed binaries would make the important case opaque: a reviewer
seeing `scanned.pdf` has to take on faith that it really has no text layer.
Here it is one visible argument.

## Testing that something does not exist

`unit/ingestion-surface.test.ts` asserts the absence of a document upload
feature: no route imports the pipeline, no route reads `formData()`, no page
renders a file input, and the list of routes is a whitelist.

A boundary enforced by code that has not been written yet is strong right up
until someone writes it in a hurry. Written down as an assertion, adding an
upload endpoint becomes a decision with a failing test attached rather than a
diff nobody looked at closely.
