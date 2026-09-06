import { redirect } from 'next/navigation';

import { SignInButton } from '@/components/auth/sign-in-button';
import { APP_NAME } from '@/lib/constants';
import { signIn } from '@/server/auth';
import { diagnoseAuthConfig } from '@/server/auth/diagnostics';
import { getLastAuthFailure } from '@/server/auth/last-error';
import { getOptionalUser } from '@/server/auth/require-user';

/**
 * The sign-in page.
 *
 * A Server Component. The button posts to a Server Action, so the OAuth flow
 * is started on the server and the client secret never goes near the browser.
 */

export const dynamic = 'force-dynamic';

/**
 * Auth.js error codes, translated into something a person can act on.
 *
 * The raw codes are for developers, and showing them to a user is both
 * unhelpful and a small information leak about the internals. Anything
 * unrecognized falls through to a generic message rather than being rendered
 * verbatim, since the query string is attacker-controlled.
 */
const ERROR_MESSAGES: Record<string, string> = {
  OAuthAccountNotLinked:
    'That email address is already registered with a different sign-in method.',
  AccessDenied: 'Sign-in was cancelled, or your Google account could not be verified.',
  Configuration: 'Sign-in is not configured correctly on the server.',
  Verification: 'That sign-in link has expired. Please try again.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  // Already signed in: send them on rather than showing a pointless button.
  const existing = await getOptionalUser();
  if (existing) redirect('/dashboard');

  const params = await searchParams;
  const errorMessage = params.error
    ? (ERROR_MESSAGES[params.error] ?? 'Sign-in failed. Please try again.')
    : null;

  /**
   * The detail behind a `Configuration` error, in development only.
   *
   * Auth.js reports four separate failures under one code, so the generic
   * sentence above leaves you guessing which variable is at fault. This names
   * it. Variable names only: no values, no lengths, no masked fragments.
   *
   * Withheld in production because this page is public, and listing the
   * variables a deployment is missing is free reconnaissance for anyone who
   * loads it.
   */
  const diagnosis =
    params.error === 'Configuration' && process.env.NODE_ENV !== 'production'
      ? diagnoseAuthConfig()
      : null;

  /**
   * What Auth.js actually said, captured when it failed.
   *
   * This is the `[auth][details]` line from the terminal, which names the
   * real cause. It beats the guesses below whenever it is present, so it is
   * rendered first. Returns null in production and before any failure.
   */
  const failure = params.error ? getLastAuthFailure() : null;

  /**
   * Only a path is accepted as a return destination, never a full URL.
   *
   * Reflecting an arbitrary URL here would be an open redirect: an attacker
   * sends someone a link to our real login page that bounces to their fake one
   * afterwards, and the victim sees our domain in the address bar the whole
   * time they are being handed off.
   */
  const rawCallback = params.callbackUrl ?? '/dashboard';
  const callbackUrl = rawCallback.startsWith('/') && !rawCallback.startsWith('//')
    ? rawCallback
    : '/dashboard';

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <header className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{APP_NAME}</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Sign in to upload documents and ask questions about them.
          </p>
        </header>

        {errorMessage ? (
          <div
            role="alert"
            className="mt-6 rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm leading-relaxed text-ink"
          >
            {errorMessage}

            {/* The real reason, when we have it. Rendered above the guesses
                because it replaces them. */}
            {failure ? (
              <div className="mt-3 border-t border-danger/30 pt-3">
                <p className="text-xs text-ink-soft">
                  Development only. What the server actually reported:
                </p>
                <p className="mt-2 font-mono text-xs break-words text-danger">
                  {failure.name}
                  {failure.detail ? `: ${failure.detail}` : ''}
                </p>
              </div>
            ) : null}

            {diagnosis && diagnosis.missing.length > 0 ? (
              <div className="mt-3 border-t border-danger/30 pt-3">
                <p className="text-xs text-ink-soft">
                  Development only. Add {diagnosis.missing.length === 1 ? 'this' : 'these'} to{' '}
                  <code className="font-mono">.env.local</code> in the project root, then restart
                  the server:
                </p>
                <ul className="mt-2 flex flex-col gap-1">
                  {diagnosis.missing.map((variable) => (
                    <li key={variable.name} className="font-mono text-xs">
                      <span className="text-danger">{variable.name}</span>
                      <span className="text-muted"> {variable.why}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {diagnosis?.parseError ? (
              <div className="mt-3 border-t border-danger/30 pt-3">
                <p className="text-xs text-ink-soft">
                  Development only. A variable is set but invalid:
                </p>
                <p className="mt-2 font-mono text-xs text-danger">{diagnosis.parseError}</p>
              </div>
            ) : null}

            {diagnosis?.ok ? (
              <div className="mt-3 border-t border-danger/30 pt-3">
                <p className="text-xs text-ink-soft">
                  Development only. All four variables are set, so they are present but being{' '}
                  <strong className="font-medium text-ink">rejected</strong>. In order of
                  likelihood:
                </p>
                <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-4 text-xs text-ink-soft">
                  <li>
                    <code className="font-mono text-danger">GOOGLE_CLIENT_SECRET</code> is wrong.
                    Google returns{' '}
                    <code className="font-mono">
                      invalid_client: The provided client secret is invalid
                    </code>
                    . Copy it again from Cloud Console, or reset it. Getting this far means the
                    client id and redirect URI are already correct.
                  </li>
                  <li>
                    The database is unreachable, so no session can be written. A TLS error from
                    Atlas usually means your current IP is not in Network Access. Check{' '}
                    <a className="text-accent underline underline-offset-2" href="/api/health/db">
                      /api/health/db
                    </a>
                    .
                  </li>
                  <li>
                    The redirect URI in Cloud Console is not exactly{' '}
                    <code className="font-mono">
                      http://localhost:3000/api/auth/callback/google
                    </code>
                    .
                  </li>
                </ol>
                <p className="mt-2 text-xs text-muted">
                  The server terminal prints the exact reason on the{' '}
                  <code className="font-mono">[auth][details]</code> line.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        <form
          className="mt-6"
          action={async () => {
            'use server';
            await signIn('google', { redirectTo: callbackUrl });
          }}
        >
          <SignInButton />
        </form>

        <p className="mt-6 text-center text-xs leading-relaxed text-muted">
          We receive only your name, email address and profile picture. Your Google password is
          never seen by this application.
        </p>
      </div>
    </main>
  );
}
