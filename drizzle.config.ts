import { existsSync, readFileSync } from 'node:fs';
import type { Config } from 'drizzle-kit';

// Load secrets manually — drizzle-kit runs outside of Bun's built-in env loading.
// Reads .env if present, falls back to .dev.vars (wrangler's local secrets file).
function loadEnv(): Record<string, string> {
  const file = existsSync('.env') ? '.env' : existsSync('.dev.vars') ? '.dev.vars' : null;
  if (!file) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    result[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return result;
}

const env = loadEnv();
const dbSrc = (env['DB_SRC'] ?? process.env['DB_SRC'] ?? 'turso') as 'local' | 'turso';

export default (dbSrc === 'local'
  ? {
      schema: './src/db/schema.ts',
      out: './src/db/migrations',
      dialect: 'sqlite',
      dbCredentials: { url: 'file:local.sqlite' },
    }
  : {
      schema: './src/db/schema.ts',
      out: './src/db/migrations',
      dialect: 'turso',
      dbCredentials: {
        url: env['TURSO_DB_URL'] ?? process.env['TURSO_DB_URL'] ?? '',
        authToken: env['TURSO_AUTH_TOKEN'] ?? process.env['TURSO_AUTH_TOKEN'] ?? '',
      },
    }) satisfies Config;
