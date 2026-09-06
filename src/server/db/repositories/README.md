# Repositories

One module per collection. **Implemented.**

`users` · `documents` · `document_chunks` · `conversations` · `messages`

Every exported function that touches user-owned data takes `userId` and filters
on it. A record belonging to another user reads as absent (`null`, `[]`, `0`,
`false`), never as an error: a distinguishable response would confirm the id
exists and let someone enumerate other people's records.

`users.repo.ts` is the exception that proves the rule. It takes no `userId`
because there the user is the record rather than something a user owns.

## Denormalized ownership

`messages` stores `userId` as well as `conversationId`, so an ownership check
is one indexed lookup rather than a join. The cost is that writes have to prove
the relationship instead of asserting it: `createMessage` verifies the parent
conversation belongs to the caller before inserting. Without that check, a
caller could pass its own `userId` with someone else's `conversationId` and
write into their thread.
