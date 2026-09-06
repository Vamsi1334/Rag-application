// Test stub for the 'server-only' package.
// That package throws outside a React Server Component, which would make every
// server module untestable. Vitest aliases it here so tests can import the real
// code; the build still uses the real package, so the boundary it guards is
// unchanged.
export {};
