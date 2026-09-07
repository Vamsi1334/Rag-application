import Link from 'next/link';
import { redirect } from 'next/navigation';

import { DocumentChat } from '@/components/ai/document-chat';
import { getEmbeddingConfig, getLLMConfig } from '@/server/ai/factory';
import { getOptionalUser } from '@/server/auth/require-user';
import { listDocumentsForUser } from '@/server/db/repositories/documents.repo';
import { countChunksForUser } from '@/server/db/repositories/document-chunks.repo';
import { KNOWLEDGE_BASE_OWNER_ID } from '@/server/db/types';
import { isAppError } from '@/server/observability/errors';
import type { DocumentDoc } from '@/server/db/types';

/**
 * The document chat page.
 *
 * A Server Component that checks three things before rendering the input box,
 * because each one produces a different and more useful message than letting
 * the user discover it by asking a question and reading an error:
 *
 *   1. Is anyone signed in?
 *   2. Are both models configured? Two are needed here, not one: Voyage to
 *      embed the question and Groq to write the answer.
 *   3. Is there anything to search? A corpus with no documents answers
 *      "I could not find that" to everything, which reads like a broken
 *      product rather than an empty one.
 */

export const dynamic = 'force-dynamic';

/** Both configs, or the name of the first variable that is missing. */
function readConfig():
  | { ok: true; llmModel: string; embeddingModel: string }
  | { ok: false; variable: string } {
  try {
    return {
      ok: true,
      llmModel: getLLMConfig().model,
      embeddingModel: getEmbeddingConfig().model,
    };
  } catch (error) {
    if (isAppError(error) && error.code === 'CONFIGURATION_ERROR') {
      const variable = error.logMeta.variable;
      // The NAME of the missing variable, never a value. This project put that
      // name there itself.
      return { ok: false, variable: typeof variable === 'string' ? variable : 'API key' };
    }
    throw error;
  }
}

export default async function ChatPage() {
  const user = await getOptionalUser();
  if (!user) redirect('/login?callbackUrl=/chat');

  const config = readConfig();

  if (!config.ok) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <PageHeader />
        <div className="mt-8 rounded-lg border border-warn/40 bg-warn-soft p-4 text-sm leading-relaxed">
          <p className="font-medium text-ink">
            <code className="font-mono">{config.variable}</code> is not set.
          </p>
          <p className="mt-2 text-ink-soft">
            This page needs two models: one to turn your question into a vector, and one to write
            the answer. Add the variable to <code className="font-mono">.env.local</code> and
            restart the server.
          </p>
        </div>
      </main>
    );
  }

  /**
   * What is actually searchable, read from the shared knowledge base.
   *
   * Counted under the sentinel owner rather than the signed-in user, because
   * in this version nobody uploads anything: there is one curated corpus that
   * every signed-in person reads.
   */
  const documents = await listDocumentsForUser(KNOWLEDGE_BASE_OWNER_ID, { limit: 20 });
  const ready = documents.filter((document) => document.status === 'ready');
  const chunkCount = await countChunksForUser(KNOWLEDGE_BASE_OWNER_ID);

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <PageHeader />

      <section className="mt-8">
        {ready.length === 0 ? <EmptyCorpus documents={documents} /> : <Corpus documents={ready} chunkCount={chunkCount} />}
      </section>

      <section className="mt-8">
        <DocumentChat />
      </section>

      <footer className="mt-12 border-t border-line pt-6">
        <p className="font-mono text-xs leading-relaxed text-muted">
          {config.embeddingModel} embeds &middot; {config.llmModel} answers &middot; signed in as{' '}
          {user.email}
        </p>
      </footer>
    </main>
  );
}

function Corpus({ documents, chunkCount }: { documents: DocumentDoc[]; chunkCount: number }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <h2 className="font-mono text-xs uppercase tracking-widest text-muted">
        What you can ask about
      </h2>
      <ul className="mt-3 flex flex-col gap-1">
        {documents.map((document) => (
          <li key={document._id.toHexString()} className="text-sm text-ink">
            {document.originalName}{' '}
            <span className="font-mono text-xs tabular-nums text-muted">
              {document.chunkCount} passages
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs leading-relaxed text-muted">
        {chunkCount} searchable passages in total. Questions are matched against these by meaning,
        not by keyword, so wording it differently from the document is fine.
      </p>
    </div>
  );
}

function EmptyCorpus({ documents }: { documents: DocumentDoc[] }) {
  // A document that exists but is not `ready` is a different problem from no
  // document at all, and the fix is different too.
  const failed = documents.filter((document) => document.status === 'failed');

  return (
    <div className="rounded-lg border border-warn/40 bg-warn-soft p-4 text-sm leading-relaxed">
      <p className="font-medium text-ink">There is nothing to search yet.</p>
      {failed.length > 0 ? (
        <p className="mt-2 text-ink-soft">
          {failed.length === 1 ? 'A document was' : `${failed.length} documents were`} ingested but
          did not finish. Re-run the ingest script; a failed document is retried automatically.
        </p>
      ) : (
        <p className="mt-2 text-ink-soft">
          Add the company document from a terminal:{' '}
          <code className="font-mono">npx tsx scripts/ingest-document.ts ./docs/your-file.pdf</code>
        </p>
      )}
      <p className="mt-2 text-ink-soft">
        Until then every question here answers &ldquo;I could not find that&rdquo;, which is
        correct but not much use.
      </p>
    </div>
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
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Ask the document</h1>
      <p className="mt-3 max-w-xl leading-relaxed text-ink-soft">
        Your question is searched against the company document, and the answer is written from the
        passages that came back. Every answer shows the passages it was allowed to use, so you can
        check it rather than trust it.
      </p>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
        Compare with{' '}
        <Link href="/ai-test" className="text-accent underline underline-offset-2">
          the model test page
        </Link>
        , which asks the same model with no document at all. Ask both the same question about your
        document to see the difference.
      </p>
    </header>
  );
}
