import { askRequestSchema, type AskResponse } from '@/lib/schemas/ask';
import { requireUser } from '@/server/auth/require-user';
import { ValidationError } from '@/server/observability/errors';
import { createRoute, json } from '@/server/http/route';
import { getRequestId } from '@/server/observability/request-context';
import { answerQuestion } from '@/server/rag/answer';

/**
 * POST /api/ai/ask
 *
 * The RAG endpoint. Compare it with `/api/ai/chat`, which is the same shape
 * with the middle removed:
 *
 *   /api/ai/chat   question ------------------------------> model -> answer
 *   /api/ai/ask    question -> embed -> search -> passages -> model -> answer
 *
 * Those three extra steps are the entire difference between an answer about
 * your document and an answer that merely sounds like one.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = createRoute('ai.ask', async (request: Request) => {
  /**
   * Who is asking, before anything else happens.
   *
   * Two reasons, and the second is the important one.
   *
   * The obvious reason is cost: everything below this line spends a Voyage
   * request and a Groq request, and an unauthenticated endpoint that does that
   * is a way for a stranger to burn a rate limit.
   *
   * The real reason is that `user.userId` IS the search boundary. It is passed
   * into the vector search as the filter that decides which passages exist as
   * far as this question is concerned. It has to come from the session and
   * nowhere else, which is why the request schema has no user field at all.
   */
  const user = await requireUser();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError('Request body was not valid JSON', { operation: 'ai.ask' });
  }

  const parsed = askRequestSchema.safeParse(raw);
  if (!parsed.success) {
    // Field names and rules reach the log. The question never does: it is the
    // user's own text.
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      { operation: 'ai.ask' },
    );
  }

  const result = await answerQuestion({
    question: parsed.data.question,
    userId: user.userId,
    signal: request.signal,
  });

  const body: AskResponse = {
    answer: result.answer,
    // Only what the reader needs to check the answer. The embedding vector and
    // the internal chunk id stay on the server.
    sources: result.passages.map((passage) => ({
      rank: passage.rank,
      content: passage.content,
      ...(passage.sourceName ? { sourceName: passage.sourceName } : {}),
      ...(passage.pageNumber ? { pageNumber: passage.pageNumber } : {}),
      score: passage.score,
    })),
    groundedInNothing: result.groundedInNothing,
    provider: result.provider,
    model: result.model,
    embeddingModel: result.embeddingModel,
    usage: result.usage,
    finishReason: result.finishReason,
    timings: result.timings,
    requestId: getRequestId(),
  };

  // no-store: this answer was assembled from one user's documents. A cached
  // copy is a copy some proxy might hand to somebody else.
  return json(body, { headers: { 'cache-control': 'no-store' } });
});
