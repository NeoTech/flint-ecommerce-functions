/**
 * Rate limiting middleware using Cloudflare Workers Rate Limiting API.
 *
 * CF Workers injects RATE_LIMITER_PUBLIC and RATE_LIMITER_AUTH bindings
 * (configured in wrangler.toml). On Vercel and local dev the bindings are
 * absent and rate limiting is silently skipped — Vercel handles this at the
 * infrastructure level, and local dev doesn't need it.
 *
 * Limits (configured in wrangler.toml):
 *   RATE_LIMITER_PUBLIC — 100 requests / minute per IP
 *   RATE_LIMITER_AUTH   —  30 requests / minute per IP
 */
import type { AppEnv } from '../types.js';

export type RateLimitTier = 'public' | 'auth';

function getClientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ??
    'unknown'
  );
}

/**
 * Check rate limit for the given request.
 * Returns null if the request is within limits, or a 429 Response if exceeded.
 * Returns null immediately when no CF binding is present (Vercel / local dev).
 */
export async function checkRateLimit(
  request: Request,
  env: AppEnv,
  tier: RateLimitTier = 'public',
): Promise<Response | null> {
  const limiter = tier === 'auth' ? env.RATE_LIMITER_AUTH : env.RATE_LIMITER_PUBLIC;

  // No binding present — skip silently (Vercel / local dev).
  if (!limiter) return null;

  const ip = getClientIp(request);
  const { success } = await limiter.limit({ key: ip });

  if (!success) {
    return new Response(
      JSON.stringify({
        data: null,
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
      }),
      {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  return null;
}
