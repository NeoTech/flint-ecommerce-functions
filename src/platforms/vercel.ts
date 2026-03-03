/**
 * Vercel Edge Function entry point.
 *
 * Exports a default fetch handler compatible with the Vercel Edge runtime.
 * All routing and middleware is handled by src/router.ts.
 */
import '../app.js';
import { dispatch } from '../router.js';
import type { AppEnv } from '../types.js';

export default async function handler(request: Request): Promise<Response> {
  // Build a minimal AppEnv from Vercel environment variables.
  // Vercel injects env vars as process.env (available in edge runtime).
  const env: AppEnv = {
    ENVIRONMENT: (process.env['ENVIRONMENT'] ?? 'production') as AppEnv['ENVIRONMENT'],
    DB_SRC: (process.env['DB_SRC'] ?? 'turso') as AppEnv['DB_SRC'],
    TURSO_DB_URL: process.env['TURSO_DB_URL'] ?? '',
    TURSO_AUTH_TOKEN: process.env['TURSO_AUTH_TOKEN'] ?? '',
    JWT_PUBLIC_KEY: process.env['JWT_PUBLIC_KEY'] ?? '',
    JWT_PRIVATE_KEY: process.env['JWT_PRIVATE_KEY'] ?? '',
    ALLOWED_ORIGINS: process.env['ALLOWED_ORIGINS'] ?? '',
    // RATE_LIMITER_PUBLIC / RATE_LIMITER_AUTH are CF-only bindings; absent here.
  };

  return dispatch(request, env);
}
