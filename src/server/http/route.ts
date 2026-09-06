import 'server-only';
// Route wrapping is a server concern and pulls in the Node-only logger.

import { logError, logInfo } from '@/server/observability/logger';
import { toAppError, toErrorResponseBody } from '@/server/observability/errors';
import {
  resolveRequestId,
  runWithRequestContext,
  type RequestContext,
} from '@/server/observability/request-context';

/**
 * The wrapper every API route goes through.
 *
 * Without it, each route handler has to remember to generate a request id,
 * time itself, catch its own errors, decide a status code and avoid leaking
 * internals. One of them will eventually forget, and it will be the one
 * handling a failure at 2am.
 *
 * With it, a route handler contains only the work it exists to do, and
 * everything below is guaranteed:
 *   - every request gets an id, reused from `x-request-id` if upstream sent one
 *   - the id is on every log line the request produces, and on the response
 *   - the duration and outcome are logged
 *   - a thrown error becomes the correct status and a body that says nothing
 *     it should not
 */
export type Handler = (request: Request) => Promise<Response> | Response;

export function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

export function createRoute(operation: string, handler: Handler): Handler {
  return async function wrappedHandler(request: Request): Promise<Response> {
    const requestId = resolveRequestId(request.headers.get('x-request-id'));
    const context: RequestContext = { requestId, startedAt: Date.now() };
    const url = new URL(request.url);

    return runWithRequestContext(context, async () => {
      try {
        const response = await handler(request);
        logInfo(
          {
            operation,
            method: request.method,
            path: url.pathname,
            statusCode: response.status,
            durationMs: Date.now() - context.startedAt,
          },
          'request completed',
        );
        return withRequestId(response, requestId);
      } catch (error) {
        const appError = toAppError(error);
        logError(error, {
          operation,
          method: request.method,
          path: url.pathname,
          durationMs: Date.now() - context.startedAt,
        });

        return withRequestId(
          Response.json(toErrorResponseBody(appError, requestId), {
            status: appError.httpStatus,
          }),
          requestId,
        );
      }
    });
  };
}

/**
 * Echoes the request id back to the caller.
 *
 * This is what turns a user saying "it broke" into a single log query. Ask
 * them for the id shown in the error and every line for that request is one
 * search away.
 */
function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('x-request-id', requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
