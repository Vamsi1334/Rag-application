import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ChatTester } from '@/components/ai/chat-tester';
import { getLLMConfig } from '@/server/ai/factory';
import { getOllamaStatus } from '@/server/ai/providers';
import { getOptionalUser } from '@/server/auth/require-user';
import { getProviderDescriptor, type ProviderDescriptor } from '@/server/config/providers';
import { isAppError } from '@/server/observability/errors';
import type { LLMProviderConfig } from '@/server/ai/types';

/**
 * The LLM test page.
 *
 * A Server Component that does two things before rendering anything:
 *
 *   1. Checks the session. This page drives a paid model, so it sits behind
 *      sign-in exactly like the dashboard does.
 *   2. Checks the provider's state, so the page can say "GROQ_API_KEY is not
 *      set" or "Ollama is not running" up front, instead of making you
 *      discover it by sending a question and reading an error.
 *
 * This page exists to prove the plumbing works. It is replaced by the real
 * document chat once retrieval exists.
 */

export const dynamic = 'force-dynamic';

/**
 * The provider's configuration, or the name of the variable that is missing.
 *
 * `getLLMConfig()` throws when a hosted provider has no credential, which is
 * the right behaviour for a route but a poor one for a page: an unhandled
 * throw here is a 500 with no explanation. Catching it turns the same
 * condition into a sentence someone can act on.
 *
 * Only the variable NAME is read from the error, never a value, and the name
 * is one this application put there itself.
 */
function readConfig():
  | { ok: true; config: LLMProviderConfig; descriptor: ProviderDescriptor }
  | { ok: false; variable: string } {
  try {
    const config = getLLMConfig();
    return { ok: true, config, descriptor: getProviderDescriptor(config.provider) };
  } catch (error) {
    if (isAppError(error) && error.code === 'CONFIGURATION_ERROR') {
      const variable = error.logMeta.variable;
      return { ok: false, variable: typeof variable === 'string' ? variable : 'LLM_API_KEY' };
    }
    throw error;
  }
}

export default async function AiTestPage() {
  // Same check the dashboard makes, and for the same reason: the middleware
  // only saw that a cookie existed. This resolves it against the database.
  const user = await getOptionalUser();
  if (!user) redirect('/login?callbackUrl=/ai-test');

  const resolved = readConfig();

  if (!resolved.ok) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <PageHeader />
        <div className="mt-8 rounded-lg border border-warn/40 bg-warn-soft p-4 text-sm leading-relaxed">
          <p className="font-medium text-ink">
            <code className="font-mono">{resolved.variable}</code> is not set.
          </p>
          <p className="mt-2 text-ink-soft">
            Add it to <code className="font-mono">.env.local</code> and restart the server. There
            is a free key at{' '}
            <a
              className="text-accent underline underline-offset-2"
              href="https://console.groq.com"
              target="_blank"
              rel="noreferrer"
            >
              console.groq.com
            </a>{' '}
            under Settings, API Keys. To run locally instead, set{' '}
            <code className="font-mono">LLM_PROVIDER=ollama</code>, which needs no key at all.
          </p>
        </div>
      </main>
    );
  }

  const { config, descriptor } = resolved;

  // Only meaningful for a local provider. A hosted one is reachable or not at
  // the moment you call it, and probing it here would spend a request on every
  // page load just to find out.
  const isLocal = config.provider === 'ollama';
  const status = isLocal
    ? await getOllamaStatus(config.baseUrl)
    : { reachable: true, models: [] as string[] };

  // Ollama reports models as "name:tag"; a bare name means the default tag.
  const modelPresent =
    !isLocal ||
    status.models.includes(config.model) ||
    status.models.some((m) => m.split(':')[0] === config.model.split(':')[0]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <PageHeader />

      <section className="mt-8">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-line bg-surface p-4 font-mono text-xs sm:grid-cols-4">
          <div>
            <dt className="uppercase tracking-wider text-muted">provider</dt>
            <dd className="mt-1 text-ink">{descriptor.label}</dd>
          </div>
          <div>
            <dt className="uppercase tracking-wider text-muted">model</dt>
            <dd className="mt-1 break-words text-ink">{config.model}</dd>
          </div>
          <div>
            <dt className="uppercase tracking-wider text-muted">context</dt>
            <dd className="mt-1 tabular-nums text-ink">{config.contextWindow} tokens</dd>
          </div>
          <div>
            <dt className="uppercase tracking-wider text-muted">
              {isLocal ? 'runtime' : 'credential'}
            </dt>
            <dd className={`mt-1 ${status.reachable ? 'text-accent' : 'text-danger'}`}>
              {isLocal ? (status.reachable ? 'reachable' : 'unreachable') : 'configured'}
            </dd>
          </div>
        </dl>

        {/* The base URL and the API key are deliberately absent above. One is
            configuration this page does not need to display to be useful, and
            the other must never reach a browser at all. */}

        {isLocal && !status.reachable ? (
          <div className="mt-4 rounded-lg border border-danger/40 bg-danger-soft p-4 text-sm leading-relaxed">
            <p className="font-medium text-ink">The model runtime is not responding.</p>
            <p className="mt-2 text-ink-soft">
              Start it with <code className="font-mono">ollama serve</code>, or open the Ollama
              app. On Windows it usually starts on its own after install.
            </p>
          </div>
        ) : null}

        {isLocal && status.reachable && !modelPresent ? (
          <div className="mt-4 rounded-lg border border-warn/40 bg-warn-soft p-4 text-sm leading-relaxed">
            <p className="font-medium text-ink">
              Ollama is running, but <code className="font-mono">{config.model}</code> is not
              installed.
            </p>
            <p className="mt-2 text-ink-soft">
              Download it with <code className="font-mono">ollama pull {config.model}</code>.
              {status.models.length > 0
                ? ` Installed right now: ${status.models.join(', ')}.`
                : ' No models are installed yet.'}
            </p>
          </div>
        ) : null}
      </section>

      <section className="mt-8">
        <ChatTester />
      </section>

      <footer className="mt-12 border-t border-line pt-6">
        <p className="font-mono text-xs text-muted">
          signed in as {user.email} &middot; requests are attributed to your account
        </p>
      </footer>
    </main>
  );
}

function PageHeader() {
  return (
    <header className="border-b border-line pb-8">
      <Link
        href="/dashboard"
        className="font-mono text-xs uppercase tracking-widest text-accent hover:underline"
      >
        &larr; Dashboard
      </Link>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Model test</h1>
      <p className="mt-3 max-w-xl leading-relaxed text-ink-soft">
        Sends your question straight to the configured model. No documents, no retrieval, no
        history: just the round trip, so the plumbing can be checked on its own.
      </p>
    </header>
  );
}
