import { chatRequestSchema, type ChatResponse } from '@/lib/schemas/chat';
import { getLLMProvider } from '@/server/ai/factory';
import { requireUser } from '@/server/auth/require-user';
import { ValidationError } from '@/server/observability/errors';
import { createRoute, json } from '@/server/http/route';
import { logInfo } from '@/server/observability/logger';
import { getRequestId } from '@/server/observability/request-context';

/**
 * POST /api/ai/chat
 *
 * The simplest possible path through the system:
 *
 *   browser -> this route -> LLM provider -> Groq -> model -> back again
 *
 * No retrieval, no documents, no history. Getting this working end to end,
 * and understanding every hop, is the point of this phase; RAG is the same
 * flow with retrieved passages inserted before the model call.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = createRoute('ai.chat', async (request: Request) => {
  // ---- 1. Establish who is asking ----------------------------------------
  // First line of the handler, deliberately. Everything after it costs money:
  // an unauthenticated endpoint that calls a paid model is a way for a
  // stranger to spend your rate limit, and reading the body before checking
  // the session means an anonymous caller can still make the server work.
  //
  // `requireUser` reads the session cookie, resolves it against the sessions
  // collection and throws UnauthorizedError when there is no valid session.
  // `createRoute` turns that into a 401 with a safe body. It also records the
  // user id in the request context, so every log line below carries it
  // without being passed one.
  //
  // This is what replaced the ENABLE_AI_TEST_ENDPOINT flag that used to guard
  // this route. A feature flag hides an endpoint; a session actually protects
  // it, and it is the same check every future route will make.
  const user = await requireUser();

  // ---- 2. Parse the body -------------------------------------------------
  // Malformed JSON throws from .json() and would otherwise surface as a 500,
  // when it is squarely the caller's problem.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError('Request body was not valid JSON', { operation: 'ai.chat' });
  }

  // ---- 3. Validate it ----------------------------------------------------
  const parsed = chatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    // Only the field name and rule reach the log; the value never does, since
    // it is user content.
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      { operation: 'ai.chat' },
    );
  }

  // ---- 4. Ask the configured provider ------------------------------------
  // Note what is absent: the word "Groq". This route has no idea which
  // provider it is talking to, which is what makes switching to another one a
  // config change rather than a rewrite.
  const provider = getLLMProvider();
  const startedAt = Date.now();

  const completion = await provider.complete({
    messages: [{ role: 'user', content: parsed.data.message }],
    signal: request.signal,
  });

  const durationMs = Date.now() - startedAt;

  // ---- 5. Log the shape of the call, never its content -------------------
  // Token counts, timing and finish reason are what you need to diagnose a
  // slow or truncated answer. The question and the answer are the user's, and
  // logging them would put private content in a place it does not belong.
  //
  // `userId` is included explicitly as well as through the request context: it
  // is the field that makes "who ran up this bill" answerable, and it should
  // not silently disappear if the context mechanism is ever changed. It is an
  // opaque id, never the email address.
  logInfo(
    {
      operation: 'ai.chat',
      userId: user.userIdString,
      provider: provider.id,
      model: provider.model,
      promptTokens: completion.usage.promptTokens,
      completionTokens: completion.usage.completionTokens,
      finishReason: completion.finishReason,
      durationMs,
    },
    'LLM completion succeeded',
  );

  const body: ChatResponse = {
    answer: completion.text,
    provider: provider.id,
    model: provider.model,
    usage: completion.usage,
    durationMs,
    finishReason: completion.finishReason,
    requestId: getRequestId(),
  };

  // no-store because the answer belongs to one user. A cached response is a
  // response some proxy might hand to somebody else.
  return json(body, { headers: { 'cache-control': 'no-store' } });
});
