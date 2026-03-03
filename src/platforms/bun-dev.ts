/**
 * Bun-native local dev server.
 *
 * Run via: bun run dev:bun
 * Loads secrets from .dev.vars via --env-file flag in package.json script.
 * Mirrors the Vercel shim — builds AppEnv from process.env and calls dispatch.
 *
 * CF-only bindings (rate limiters) are omitted; they fail open by design.
 */
import '../app.js';
import { dispatch } from '../router.js';
import type { AppEnv } from '../types.js';

const env: AppEnv = {
  ENVIRONMENT: (process.env['ENVIRONMENT'] ?? 'development') as AppEnv['ENVIRONMENT'],
  DB_SRC: (process.env['DB_SRC'] ?? 'turso') as AppEnv['DB_SRC'],
  TURSO_DB_URL: process.env['TURSO_DB_URL'] ?? '',
  TURSO_AUTH_TOKEN: process.env['TURSO_AUTH_TOKEN'] ?? '',
  JWT_PUBLIC_KEY: process.env['JWT_PUBLIC_KEY'] ?? '',
  JWT_PRIVATE_KEY: process.env['JWT_PRIVATE_KEY'] ?? '',
  ALLOWED_ORIGINS: process.env['ALLOWED_ORIGINS'] ?? '*',
};

const port = Number(process.env['PORT'] ?? 8787);

Bun.serve({
  port,
  fetch(request) {
    return dispatch(request, env);
  },
});

console.log(`Listening on http://localhost:${port}`);
