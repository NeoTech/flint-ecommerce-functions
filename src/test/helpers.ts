/**
 * Shared test utilities.
 *
 * Usage in test files:
 *   import { makeRequest, makeAuthHeader, buildTestEnv } from '../test/helpers.js';
 */
import { generateKeyPair, exportPKCS8, exportSPKI, SignJWT, importPKCS8 } from 'jose';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { AppEnv } from '../types.js';

// ---- Request builder -------------------------------------------------------

/**
 * Build a Request for use with dispatch().
 */
export function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(url, init);
}

// ---- Auth header builder ---------------------------------------------------

/**
 * Create a Bearer authorization header for a given userId and role.
 * Requires the JWT private key PEM string.
 */
export async function makeAuthHeader(
  userId: string,
  role: 'customer' | 'admin',
  privateKeyPem: string,
): Promise<{ Authorization: string }> {
  const privateKey = await importPKCS8(privateKeyPem, 'RS256');
  const token = await new SignJWT({ userId, role })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(privateKey);
  return { Authorization: `Bearer ${token}` };
}

// ---- Test environment builder ---------------------------------------------

export interface TestEnv {
  env: AppEnv;
  privateKeyPem: string;
  publicKeyPem: string;
  db: ReturnType<typeof drizzle>;
}

/**
 * Build a complete test environment with fresh RS256 keys and local SQLite.
 * Call this in beforeAll().
 */
export async function buildTestEnv(): Promise<TestEnv> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);
  const client = createClient({ url: 'file:local.sqlite' });
  const db = drizzle(client, {});
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  const env: AppEnv = {
    ENVIRONMENT: 'development',
    DB_SRC: 'local',
    TURSO_DB_URL: '',
    TURSO_AUTH_TOKEN: '',
    JWT_PRIVATE_KEY: privateKeyPem,
    JWT_PUBLIC_KEY: publicKeyPem,
    ALLOWED_ORIGINS: '*',
  };
  return { env, privateKeyPem, publicKeyPem, db };
}

// ---- Mock DB (for unit tests) -----------------------------------------------

/**
 * Creates a minimal mock DB object with jest-style spy functions.
 * Useful for unit tests that need to stub Drizzle queries.
 * This is a shallow mock — add properties as needed.
 */
export function mockDb() {
  const resolveWith = <T>(value: T) => () => Promise.resolve(value);

  return {
    select: () => ({
      from: () => ({
        where: resolveWith([]),
        limit: resolveWith([]),
        orderBy: resolveWith([]),
        all: resolveWith([]),
      }),
      all: resolveWith([]),
    }),
    insert: () => ({
      values: () => ({
        returning: resolveWith([]),
        run: resolveWith(undefined),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: resolveWith([]),
          run: resolveWith(undefined),
        }),
      }),
    }),
    delete: () => ({
      where: resolveWith(undefined),
    }),
    transaction: (fn: (tx: any) => Promise<any>) => fn({} as any),
  };
}
