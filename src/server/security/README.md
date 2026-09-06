# Security

**Phase 12**, though most of it is designed in from the start.

Planned files:
- `rate-limit.ts` — per-user and per-IP limits. In-memory counters do not work
  across serverless instances, so this needs shared storage.
- `file-validation.ts` — magic-byte sniffing, size and page caps. The
  client-declared MIME type is never trusted.
