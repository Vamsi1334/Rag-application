'use client';

import { useRef, useState } from 'react';

import { MAX_QUESTION_LENGTH, type AnswerSource, type AskResponse } from '@/lib/schemas/ask';
import type { ApiErrorResponse } from '@/lib/schemas/chat';

/**
 * Asking the company document a question.
 *
 * A Client Component, so it ships to the browser. It imports only from
 * `src/lib/`, never from `src/server/`, which is enforced by an ESLint rule and
 * by the `server-only` package. That boundary is what keeps the Voyage and Groq
 * keys out of the bundle.
 *
 * ------------------------------------------------------------------
 * Why the passages are shown, not just the answer
 * ------------------------------------------------------------------
 * The answer is a paragraph a language model wrote. It reads as authoritative
 * whether or not it is right, and that is precisely the failure mode this
 * application exists to manage.
 *
 * Showing the passages underneath turns "trust me" into "check me". If the
 * answer says something the passages do not, that is visible in seconds
 * instead of never.
 */

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; result: AskResponse }
  | { status: 'error'; message: string; code: string; requestId: string };

export function DocumentChat() {
  const [question, setQuestion] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const tooLong = question.length > MAX_QUESTION_LENGTH;
  const canSend = question.trim().length > 0 && !tooLong && state.status !== 'loading';

  async function send() {
    if (!canSend) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: 'loading' });

    try {
      const response = await fetch('/api/ai/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Note what is not sent: no user id. The server takes that from the
        // session, because a client that could name the user could name
        // any user.
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });

      const payload: unknown = await response.json();

      if (!response.ok) {
        const { error } = payload as ApiErrorResponse;
        setState({
          status: 'error',
          message: error?.message ?? 'Something went wrong.',
          code: error?.code ?? 'UNKNOWN',
          requestId: error?.requestId ?? '',
        });
        return;
      }

      setState({ status: 'done', result: payload as AskResponse });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setState({ status: 'idle' });
        return;
      }
      setState({
        status: 'error',
        message: 'Could not reach the server. Is the dev server still running?',
        code: 'NETWORK_ERROR',
        requestId: '',
      });
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label
          htmlFor="question"
          className="font-mono text-xs uppercase tracking-widest text-muted"
        >
          Ask the document
        </label>
        <textarea
          id="question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="What does the document say about answer engine optimisation?"
          className="w-full resize-y rounded-lg border border-line bg-surface p-3 text-sm leading-relaxed outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
        />
        <div className="flex items-center justify-between gap-3">
          <span
            className={`font-mono text-xs tabular-nums ${tooLong ? 'text-danger' : 'text-muted'}`}
          >
            {question.length} / {MAX_QUESTION_LENGTH}
            {tooLong ? ' (too long)' : ''}
          </span>
          <div className="flex items-center gap-2">
            {state.status === 'loading' ? (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="rounded-md border border-line px-3 py-2 text-sm font-medium text-ink-soft hover:bg-canvas"
              >
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void send()}
              disabled={!canSend}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface disabled:cursor-not-allowed disabled:opacity-40"
            >
              {state.status === 'loading' ? 'Searching…' : 'Ask'}
            </button>
          </div>
        </div>
      </div>

      {state.status === 'loading' ? (
        <div className="rounded-lg border border-line bg-surface p-4">
          <p className="text-sm text-muted">
            Turning your question into a vector, searching the document, then writing an answer
            from what came back.
          </p>
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="rounded-lg border border-danger/40 bg-danger-soft p-4">
          <p className="font-mono text-xs uppercase tracking-widest text-danger">{state.code}</p>
          <p className="mt-2 text-sm leading-relaxed text-ink">{state.message}</p>
          {state.code === 'UNAUTHORIZED' ? (
            <p className="mt-2 text-sm">
              <a
                className="text-accent underline underline-offset-2"
                href="/login?callbackUrl=/chat"
              >
                Sign in again
              </a>{' '}
              <span className="text-muted">to keep going.</span>
            </p>
          ) : null}
          {state.requestId ? (
            <p className="mt-2 font-mono text-xs text-muted">
              request {state.requestId}, searchable in the server logs
            </p>
          ) : null}
        </div>
      ) : null}

      {state.status === 'done' ? <Answer result={state.result} /> : null}
    </div>
  );
}

function Answer({ result }: { result: AskResponse }) {
  return (
    <div className="flex flex-col gap-4">
      <div
        className={`rounded-lg border p-4 ${
          result.groundedInNothing
            ? 'border-warn/40 bg-warn-soft'
            : 'border-line bg-surface'
        }`}
      >
        {/*
          Plain text, never HTML. Model output is untrusted, and the passages
          feeding it come out of a document that could contain any markup at
          all. Rendering this as HTML would be an XSS hole with a document as
          the delivery mechanism.
        */}
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{result.answer}</p>
      </div>

      {result.groundedInNothing ? (
        <p className="text-sm leading-relaxed text-ink-soft">
          Nothing in the document scored close enough to your question, so no answer was
          generated. That is the intended behaviour: inventing one would be worse than saying so.
        </p>
      ) : (
        <Sources sources={result.sources} />
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-xs text-muted sm:grid-cols-4">
        <div>
          <dt className="uppercase tracking-wider">passages</dt>
          <dd className="mt-0.5 tabular-nums text-ink-soft">{result.sources.length}</dd>
        </div>
        <div>
          <dt className="uppercase tracking-wider">tokens</dt>
          <dd className="mt-0.5 tabular-nums text-ink-soft">
            {result.usage.promptTokens} in / {result.usage.completionTokens} out
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wider">search</dt>
          <dd className="mt-0.5 tabular-nums text-ink-soft">
            {result.timings.embedMs + result.timings.searchMs}ms
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wider">total</dt>
          <dd className="mt-0.5 tabular-nums text-ink-soft">
            {(result.timings.totalMs / 1000).toFixed(1)}s
          </dd>
        </div>
      </dl>
    </div>
  );
}

function Sources({ sources }: { sources: AnswerSource[] }) {
  if (sources.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-xs uppercase tracking-widest text-muted">
        What the answer was allowed to see
      </h2>
      <p className="text-xs leading-relaxed text-muted">
        The model was given only these passages and told to use nothing else. Open one to check
        the answer against it.
      </p>

      {sources.map((source) => (
        <details
          key={source.rank}
          className="rounded-lg border border-line bg-surface open:bg-canvas"
        >
          <summary className="cursor-pointer list-none px-4 py-3 text-sm">
            <span className="font-mono text-xs text-accent">[{source.rank}]</span>{' '}
            <span className="text-ink-soft">
              {source.sourceName ?? 'document'}
              {source.pageNumber ? `, page ${source.pageNumber}` : ''}
            </span>{' '}
            <span className="font-mono text-xs tabular-nums text-muted">
              {/* Cosine similarity. Roughly: above 0.75 is a strong match,
                  0.6 to 0.75 is related, below that is probably noise. */}
              {source.score.toFixed(3)}
            </span>
          </summary>
          <p className="whitespace-pre-wrap border-t border-line px-4 py-3 text-sm leading-relaxed text-ink-soft">
            {source.content}
          </p>
        </details>
      ))}
    </section>
  );
}
