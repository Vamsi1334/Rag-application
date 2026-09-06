import 'server-only';

import { APP_NAME, APP_VERSION, CURRENT_PHASE, CURRENT_PHASE_NAME } from '@/lib/constants';
import { getServerEnv } from '@/server/config/env';
import { getProviderDescriptor, type ProviderId } from '@/server/config/providers';
import { resolveModel } from '@/server/ai/factory';
import { isAppError } from '@/server/observability/errors';
import { getRequestId } from '@/server/observability/request-context';

/**
 * The health report.
 *
 * Used by both `GET /api/health` and the home page, so there is one source of
 * truth for "is this thing working".
 *
 * -------------------------------------------------
 * The rule this file exists to demonstrate
 * -------------------------------------------------
 * A health endpoint is usually unauthenticated, which makes it a favourite
 * reconnaissance target. It therefore reports STATUS, never VALUES: that a
 * database URI is configured, never what it is; which model is selected, never
 * the key used to reach it. Every field below is a status word, a public
 * model name, or a number.
 */

export type CheckStatus = 'ok' | 'not_configured' | 'not_implemented' | 'error';

export interface Check {
  status: CheckStatus;
  /** Safe explanatory text. Never contains a configured value. */
  detail: string;
  /** The phase that makes this check meaningful. */
  phase: number;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  phase: number;
  phaseName: string;
  timestamp: string;
  uptimeSeconds: number;
  requestId: string;
  runtime: { node: string; environment: string };
  checks: Record<string, Check>;
}

/**
 * Whether the selected provider's own credential is present.
 *
 * Reports presence only. This endpoint is unauthenticated, so it never echoes
 * a key, a prefix, or even a length.
 */
function hasProviderKey(env: ReturnType<typeof getServerEnv>, provider: ProviderId): boolean {
  switch (provider) {
    case 'groq':
      return Boolean(env.GROQ_API_KEY);
    case 'openrouter':
      return Boolean(env.OPENROUTER_API_KEY);
    case 'openai':
      return Boolean(env.OPENAI_API_KEY);
    case 'google':
      return Boolean(env.GOOGLE_AI_API_KEY);
    default:
      // Local providers need no credential.
      return true;
  }
}

export function buildHealthReport(): HealthReport {
  const checks: Record<string, Check> = {};

  let environment: string;
  try {
    const env = getServerEnv();
    environment = env.NODE_ENV;

    checks.environment = {
      status: 'ok',
      detail: 'All environment variables parsed and valid.',
      phase: 1,
    };

    // Deliberately does NOT open a connection. This endpoint should stay fast
    // and never fail because of a slow cluster; /api/health/db is the one that
    // actually proves reachability.
    checks.database = env.MONGODB_URI
      ? { status: 'ok', detail: 'MONGODB_URI is set. Check /api/health/db to verify the connection.', phase: 2 }
      : { status: 'not_configured', detail: 'MONGODB_URI is not set. Required for documents and conversations.', phase: 2 };

    // MONGODB_URI belongs in this list even though it reads like a database
    // concern. Sessions are stored in the database, so Auth.js cannot build its
    // adapter without it and sign-in fails with the same unhelpful
    // "Configuration" error as a missing client secret. Reporting
    // authentication as "ok" while it is absent sends people hunting in the
    // wrong place.
    const authConfigured = Boolean(
      env.AUTH_SECRET && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.MONGODB_URI,
    );
    // Reports only whether the variables are PRESENT. This endpoint is
    // unauthenticated, so it never echoes a client id, let alone a secret, and
    // it does not say which of them is missing.
    checks.authentication = authConfigured
      ? { status: 'ok', detail: 'Google OAuth is configured. Sign in at /login.', phase: 4 }
      : {
          status: 'not_configured',
          detail:
            'Sign-in needs AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and MONGODB_URI in .env.local. In development, /login names the missing one.',
          phase: 4,
        };

    const llm = getProviderDescriptor(env.LLM_PROVIDER);
    // Resolved by the factory's own function rather than a copy of its rules,
    // so this report cannot claim a different model than the one that would
    // actually be used.
    const llmModel = resolveModel(env, env.LLM_PROVIDER);

    // A hosted provider is useless without its credential, and reporting it as
    // "ok" would send someone hunting elsewhere when the first request 401s.
    const credentialMissing =
      llm.requiresApiKey && !env.LLM_API_KEY && !hasProviderKey(env, env.LLM_PROVIDER);

    checks.llm = {
      status: !llm.implemented ? 'not_implemented' : credentialMissing ? 'not_configured' : 'ok',
      detail: !llm.implemented
        ? `Configured provider "${llm.label}" is not implemented yet.`
        : credentialMissing
          ? `Provider "${llm.label}" is selected but its API key is not set.`
          : `Provider "${llm.label}" with model "${llmModel}". Try it at /ai-test.`,
      phase: 3,
    };

    const embedding = getProviderDescriptor(env.EMBEDDING_PROVIDER);
    checks.embeddings = {
      // Ollama's CHAT provider is built; its embedding provider is not, so the
      // catalog's `implemented` flag is not the right signal here.
      status: 'not_implemented',
      detail: `Configured provider "${embedding.label}" with model "${env.EMBEDDING_MODEL}" at ${env.EMBEDDING_DIMENSIONS} dimensions. Embeddings arrive in a later phase.`,
      phase: 5,
    };
  } catch (error) {
    environment = process.env.NODE_ENV ?? 'unknown';
    checks.environment = {
      status: 'error',
      // An AppError's safeMessage is written for exactly this situation.
      detail: isAppError(error)
        ? error.safeMessage
        : 'Environment configuration could not be read.',
      phase: 1,
    };
  }

  const degraded = Object.values(checks).some((check) => check.status === 'error');

  return {
    status: degraded ? 'degraded' : 'ok',
    service: APP_NAME,
    version: APP_VERSION,
    phase: CURRENT_PHASE,
    phaseName: CURRENT_PHASE_NAME,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    requestId: getRequestId(),
    runtime: { node: process.version, environment },
    checks,
  };
}
