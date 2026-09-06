# Shared schemas

Zod schemas for data that crosses the network, so the client and the server
validate against the same definition.

Nothing in `src/lib/` may import from `src/server/`: this folder is bundled for
the browser.
