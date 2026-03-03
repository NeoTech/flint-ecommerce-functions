/**
 * CORS helpers.
 *
 * CORS header logic lives in src/router.ts (addCorsHeaders) so it runs
 * for every response including errors. This module exports any standalone
 * CORS utilities needed by individual handlers.
 */

/** Origins that are always allowed regardless of ALLOWED_ORIGINS env var. */
export const ALWAYS_ALLOWED_ORIGINS: string[] = [];

/**
 * Check whether an origin is allowed given a comma-separated allowlist string.
 * If allowlist is '*' or empty, all origins are allowed.
 */
export function isOriginAllowed(origin: string, allowlist: string): boolean {
  if (!allowlist || allowlist === '*') return true;
  return allowlist.split(',').map((o) => o.trim()).includes(origin);
}
