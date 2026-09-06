# Database

MongoDB connection and all data access. **Implemented.**

| File | Does |
| --- | --- |
| `client.ts` | The cached `MongoClient`. One connection pool per process, surviving hot reload. |
| `collections.ts` | Typed collection accessors. Collection names appear exactly once, here. |
| `types.ts` | Entity interfaces, as MongoDB stores them. Not the API's types. |
| `schemas.ts` | Zod validation for what a caller may supply on a write. |
| `indexes.ts` | Index definitions and idempotent creation. |
| `ids.ts` | Parses untrusted ids into `ObjectId`, blocking operator injection. |
| `redact.ts` | Strips credentials from driver errors before anything is logged. |
| `repositories/` | One module per collection. |

## The rule this folder enforces

Every repository function that touches user-owned data takes `userId` as a
required argument. There is no `findDocumentById(id)`; there is only
`findDocumentForUser(id, userId)`, and it returns `null` when the owner does
not match.

Authorization is a property of the query, not a check someone remembers to
write in a route handler. `tests/integration/repositories.test.ts` has a
`cross-user isolation` suite where a second user attempts to reach every one of
the first user's records through every function; it must keep passing.

## Why the native driver and not Mongoose

Four reasons, the last one decisive:

1. Vector search uses a `$vectorSearch` aggregation stage with a filter on
   fields declared in the Atlas index. That pipeline has to be exactly right,
   and an ODM's translation layer sits directly on top of it.
2. Mongoose's model registry conflicts with Next.js hot reload, which is why
   every Mongoose-plus-Next tutorial carries an `OverwriteModelError`
   workaround.
3. Chunks hold 768-element float arrays. Mongoose casting on those is overhead
   with no benefit.
4. Auth.js's MongoDB adapter, arriving in the authentication phase, takes a
   native `MongoClient`. Using Mongoose would mean running both.

Validation still happens, through Zod at the repository boundary, which is one
schema definition rather than two that can drift.
