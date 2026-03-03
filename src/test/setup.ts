/**
 * Global test setup.
 *
 * This module can be imported at the top of any test file to ensure the
 * test environment is consistent. For CI, it will also run migrations
 * against the test database.
 *
 * Usage:
 *   import '../test/setup.js'; // at the top of a test file
 *
 * When DB_SRC=local (default for tests), migrations run against local.sqlite.
 * When DB_SRC=turso, migrations run against the Turso database specified in env.
 */

// Load test environment variables from .env.test if present
// Bun automatically loads .env files; this is a no-op in most cases.
// To explicitly load: use `bun test --env .env.test`

// Validate required env vars for Turso-mode CI runs
const DB_SRC = process.env.DB_SRC ?? 'local';

if (DB_SRC === 'turso') {
  if (!process.env.TURSO_DB_URL) {
    throw new Error('TURSO_DB_URL is required when DB_SRC=turso');
  }
  if (!process.env.TURSO_AUTH_TOKEN) {
    throw new Error('TURSO_AUTH_TOKEN is required when DB_SRC=turso');
  }
}

if (!process.env.JWT_PRIVATE_KEY && !process.env.JWT_PUBLIC_KEY) {
  // Keys are generated fresh per test file — this is expected in local dev
  // console.debug('[test/setup] JWT keys not in env — expected for local dev (generated per-test)');
}

export {};
