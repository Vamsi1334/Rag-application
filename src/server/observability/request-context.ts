import 'server-only';
// AsyncLocalStorage is a Node.js API and does not exist in the browser.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { sanitizeLogValue } from './redaction';

/**
 * Per-request context.
 *
 * ----------------------------------------------
 * CONCEPT: why not just pass a `requestId` around
 * ----------------------------------------------
 * Correlating logs needs the same id on every line a request produces. Passing
 * it as an argument means every function from the route handler down to the
 * embedding call takes a parameter it does not otherwise care about, and one
 * missing hand-off breaks the chain.
 *
 * `AsyncLocalStorage` is Node's answer. It holds a value for the duration of
 * an async call tree, so anything called during the request can read the
 * context without being handed it. It is scoped per request even under
 * concurrency, which a module-level variable would not be.
 */
export interface RequestContext {
  requestId: string;
  /** Populated once authentication exists. Always an ID, never an email. */
  userId?: string;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string {
  return storage.getStore()?.requestId ?? 'no-request-context';
}

/** Attaches the signed-in user to the current request's logs. */
export function setContextUserId(userId: string): void {
  const store = storage.getStore();
  if (store) store.userId = userId;
}

export function createRequestId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

/**
 * Reuses an upstream request id when one is supplied, so a trace survives
 * across services.
 *
 * The incoming header is attacker-controlled, so it is sanitized before it is
 * ever written to a log and rejected if nothing usable survives.
 */
export function resolveRequestId(headerValue: string | null): string {
  if (!headerValue) return createRequestId();
  const cleaned = sanitizeLogValue(headerValue);
  return cleaned.length >= 8 ? cleaned : createRequestId();
}
