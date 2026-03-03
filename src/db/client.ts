/**
 * Database client factory.
 *
 * Supports two backends controlled by the DB_SRC env var:
 *   local  — SQLite file at ./local.sqlite  (Bun dev / test; no network required)
 *   turso  — Remote Turso instance via HTTP  (staging / production; works in CF Workers + Vercel Edge)
 *
 * Usage:
 *   import { getDb } from './client.js';
 *   const db = getDb(env);
 *   const rows = await db.select().from(products).all();
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import type { AppEnv } from '../types.js';

export type Db = ReturnType<typeof getDb>;

/**
 * Create a Drizzle client for the given environment.
 * When DB_SRC=local, uses a local SQLite file (no auth token needed).
 * When DB_SRC=turso (or unset), uses Turso over HTTP.
 */
export function getDb(env: Pick<AppEnv, 'TURSO_DB_URL' | 'TURSO_AUTH_TOKEN' | 'DB_SRC'>) {
  const src = env.DB_SRC ?? 'turso';

  const client =
    src === 'local'
      ? createClient({ url: 'file:local.sqlite' })
      : createClient({ url: env.TURSO_DB_URL, authToken: env.TURSO_AUTH_TOKEN });

  return drizzle(client, { schema });
}

// Re-export schema types for convenience
export * from './schema.js';
