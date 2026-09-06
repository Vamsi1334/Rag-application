import Image from 'next/image';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { SignOutButton } from '@/components/auth/sign-out-button';
import { APP_NAME } from '@/lib/constants';
import { signOut } from '@/server/auth';
import { getOptionalUser } from '@/server/auth/require-user';
import { countDocumentsForUser } from '@/server/db/repositories/documents.repo';

/**
 * The protected dashboard.
 *
 * ---------------------------------------------------
 * The real check happens here, not in the middleware
 * ---------------------------------------------------
 * Middleware saw a session cookie and let the request through, but it runs on
 * the Edge runtime with no database access, so it could not tell whether that
 * cookie is valid. This is where the cookie is resolved against the sessions
 * collection, and where a forged or expired one is rejected.
 *
 * Note also the document count below. It is fetched through a repository that
 * takes `userId`, which is the same path every future feature will use: the id
 * comes from the session on the server, never from the request.
 */

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await getOptionalUser();

  // `redirect` rather than an error: someone arriving here without a session
  // has not done anything wrong, they just need to sign in.
  if (!user) redirect('/login?callbackUrl=/dashboard');

  // Zero for now. It proves the ownership path works end to end: session ->
  // userId -> a query filtered by that userId.
  const documentCount = await countDocumentsForUser(user.userId).catch(() => null);

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-8">
        <div className="flex items-center gap-4">
          {user.image ? (
            <Image
              src={user.image}
              alt=""
              width={48}
              height={48}
              className="size-12 rounded-full border border-line"
              // Google serves avatars from a domain we do not control, and
              // adding it to the image optimizer's allowlist means trusting it
              // to serve images. Unoptimized keeps that surface closed.
              unoptimized
            />
          ) : (
            <div
              className="flex size-12 items-center justify-center rounded-full border border-line bg-canvas font-medium text-muted"
              aria-hidden="true"
            >
              {(user.name ?? user.email).charAt(0).toUpperCase()}
            </div>
          )}
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {user.name ?? 'Signed in'}
            </h1>
            <p className="mt-0.5 text-sm text-muted">{user.email}</p>
          </div>
        </div>

        <form
          action={async () => {
            'use server';
            // Deletes the session row, not just the cookie. That is what makes
            // signing out actually revoke access.
            await signOut({ redirectTo: '/login' });
          }}
        >
          <SignOutButton />
        </form>
      </header>

      <section className="mt-10">
        <h2 className="font-mono text-xs uppercase tracking-widest text-muted">Your documents</h2>
        <div className="mt-4 rounded-lg border border-line bg-surface p-6">
          {documentCount === null ? (
            <p className="text-sm text-muted">
              Could not reach the database. Check{' '}
              <Link className="text-accent underline underline-offset-2" href="/api/health/db">
                /api/health/db
              </Link>
              .
            </p>
          ) : (
            <>
              <p className="text-sm text-ink-soft">
                {documentCount === 0
                  ? 'No documents yet. Uploading comes in the next phase.'
                  : `${documentCount} document${documentCount === 1 ? '' : 's'}.`}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-muted">
                Whatever you upload will be filtered by your user id on every read, including the
                semantic search that answers your questions. Nobody else&rsquo;s documents can
                reach your answers, and yours cannot reach theirs.
              </p>
            </>
          )}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-mono text-xs uppercase tracking-widest text-muted">
          Available now
        </h2>
        <ul className="mt-4 flex flex-col gap-2 text-sm">
          <li>
            <Link className="text-accent underline underline-offset-2" href="/ai-test">
              Model test
            </Link>{' '}
            <span className="text-muted">
              &middot; ask the local model a question, without documents
            </span>
          </li>
          <li>
            <Link className="text-accent underline underline-offset-2" href="/api/auth/me">
              /api/auth/me
            </Link>{' '}
            <span className="text-muted">&middot; your session as JSON</span>
          </li>
        </ul>
      </section>

      <footer className="mt-12 border-t border-line pt-6">
        <p className="font-mono text-xs text-muted">
          {APP_NAME} &middot; signed in as {user.userIdString}
        </p>
      </footer>
    </main>
  );
}
