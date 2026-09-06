# Authentication

Google OAuth via Auth.js, database-backed sessions, and the `requireUser()`
helper every protected route calls.

**Phase 2.** Empty by design: nothing here is imported yet.

Planned files:
- `config.ts` — Auth.js configuration and the Google provider
- `require-user.ts` — resolves the session or throws `UnauthorizedError`
