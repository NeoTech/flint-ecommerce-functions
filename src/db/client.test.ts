/**
 * DB client smoke test.
 * Connects to the Turso database using credentials from the environment
 * and verifies the connection and that all expected tables exist.
 *
 * Requires TURSO_DB_URL and TURSO_AUTH_TOKEN to be set (via .env or env vars).
 */
import { describe, it, expect } from 'bun:test';
import { getDb } from './client.js';
import { sql } from 'drizzle-orm';

const env = {
  TURSO_DB_URL: process.env['TURSO_DB_URL'] ?? Bun.env['TURSO_DB_URL'] ?? '',
  TURSO_AUTH_TOKEN: process.env['TURSO_AUTH_TOKEN'] ?? Bun.env['TURSO_AUTH_TOKEN'] ?? '',
};

const EXPECTED_TABLES = [
  'users',
  'customers',
  'addresses',
  'categories',
  'products',
  'product_variants',
  'orders',
  'order_lines',
  'shipments',
  'refresh_tokens',
];

describe('db client', () => {
  it('connects and responds to SELECT 1', async () => {
    if (!env.TURSO_DB_URL) {
      console.log('  skipped: TURSO_DB_URL not set');
      return;
    }
    const db = getDb(env);
    const result = await db.run(sql`SELECT 1 AS ok`);
    expect(result).toBeDefined();
  });

  it('all expected tables exist', async () => {
    if (!env.TURSO_DB_URL) {
      console.log('  skipped: TURSO_DB_URL not set');
      return;
    }
    const db = getDb(env);
    const result = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`,
    );
    const tableNames = result.map((r) => r.name).sort();
    for (const expected of EXPECTED_TABLES) {
      expect(tableNames).toContain(expected);
    }
  });
});
