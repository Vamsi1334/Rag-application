'use client';

import { useRef, useState } from 'react';
import { MAX_MESSAGE_LENGTH, type ApiErrorResponse, type ChatResponse } from '@/lib/schemas/chat';

/**
 * A Client Component, because it needs state and event handlers.
 *
 * It imports only from `src/lib/`, never from `src/server/`. That is enforced
 * by an ESLint rule and by the `server-only` package, and it is what keeps
 * secrets out of the browser bundle: this file ships to the client, so
 * anything it can reach ships too.
 */

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; result: ChatResponse }
  | { status: 'error'; message: string; code: string; requestId: string };

export function ChatTester() {
  const [question, setQuestion] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });
  // Lets a slow local model be cancelled instead of leaving the page stuck.
  const abortRef = useRef<AbortController | null>(null);

  const tooLong = question.length > MAX_MESSAGE_LENGTH;
  const canSend = question.trim().length > 0 && !tooLong && state.status !== 'loading';

  async function send() {
    if (!canSend) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: 'loading' });

    try {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: question }),
        signal: controller.signal,
      });

      const payload: unknown = await response.json();

      if (!response.ok) {
        // The server already decided what is safe to say. The client shows
        // that and adds nothing of its own.
        const { error } = payload as ApiErrorResponse;
        setState({
          status: 'error',
          message: error?.message ?? 'Something went wrong.',
          code: error?.code ?? 'UNKNOWN',
          requestId: error?.requestId ?? '',
        });
        return;
      }

      setState({ status: 'done', result: payload as ChatResponse });
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
    // Enter sends, Shift+Enter makes a newline. Standard for a chat box.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="question" className="font-mono text-xs uppercase tracking-widest text-muted">
          Your question
        </label>
        <textarea
          id="question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
          rows={4}
          placeholder="What is a vector database?"
          className="w-full resize-y rounded-lg border border-line bg-surface p-3 text-sm leading-relaxed outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
        />
        <div className="flex items-center justify-between gap-3">
          <span
            className={`font-mono text-xs tabular-nums ${tooLong ? 'text-danger' : 'text-muted'}`}
          >
            {question.length} / {MAX_MESSAGE_LENGTH}
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
              {state.status === 'loading' ? 'Thinking…' : 'Send'}
            </button>
          </div>
        </div>
      </div>

      {state.status === 'loading' ? (
        <div className="rounded-lg border border-line bg-surface p-4">
          <p className="text-sm text-muted">
            Waiting for the model. The first request after a pause is slow: the model has to be
            loaded into memory before it can generate anything.
          </p>
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="rounded-lg border border-danger/40 bg-danger-soft p-4">
          <p className="font-mono text-xs uppercase tracking-widest text-danger">
            {state.code}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-ink">{state.message}</p>
          {/* A session can expire while this page is open. The server answers
              401 and the generic message is correct but unhelpful, so this one
              case gets a way out. */}
          {state.code === 'UNAUTHORIZED' ? (
            <p className="mt-2 text-sm">
              <a
                className="text-accent underline underline-offset-2"
                href="/login?callbackUrl=/ai-test"
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

      {state.status === 'done' ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-line bg-surface p-4">
            {/* Plain text, not HTML. Model output is untrusted: rendering it as
                markup would be an XSS hole the moment a document containing
                markup reaches the prompt. */}
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{state.result.answer}</p>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-xs text-muted sm:grid-cols-4">
            <div>
              <dt className="uppercase tracking-wider">model</dt>
              <dd className="mt-0.5 text-ink-soft">{state.result.model}</dd>
            </div>
            <div>
              <dt className="uppercase tracking-wider">provider</dt>
              <dd className="mt-0.5 text-ink-soft">{state.result.provider}</dd>
            </div>
            <div>
              <dt className="uppercase tracking-wider">tokens</dt>
              <dd className="mt-0.5 tabular-nums text-ink-soft">
                {state.result.usage.promptTokens} in / {state.result.usage.completionTokens} out
              </dd>
            </div>
            <div>
              <dt className="uppercase tracking-wider">took</dt>
              <dd className="mt-0.5 tabular-nums text-ink-soft">
                {(state.result.durationMs / 1000).toFixed(1)}s
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
