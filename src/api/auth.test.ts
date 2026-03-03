/**
 * Auth API integration tests.
 *
 * Routes are tested through dispatch() so the full middleware chain runs.
 * Uses a local SQLite file (local.sqlite) with migrations applied in beforeAll.
 * Test data is cleaned up in afterEach to keep tests independent.
 */
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { customers, refreshTokens, users } from '../db/schema.js';
import { getDb } from '../db/client.js';
import { hashToken, issueResetToken } from '../lib/tokens.js';
// Import app to register auth routes before dispatch is called.
import '../app.js';
import { dispatch } from '../router.js';
import type { AppEnv } from '../types.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let env: AppEnv;
let cleanupDb: ReturnType<typeof drizzle>;

const BASE = 'https://test.local';

beforeAll(async () => {
  // Generate a fresh RS256 key pair for this test run.
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
  const JWT_PUBLIC_KEY = await exportSPKI(publicKey);

  // Apply migrations to local.sqlite.
  const client = createClient({ url: 'file:local.sqlite' });
  cleanupDb = drizzle(client, {});
  await migrate(cleanupDb, { migrationsFolder: './src/db/migrations' });

  env = {
    ENVIRONMENT: 'development',
    DB_SRC: 'local',
    TURSO_DB_URL: '',
    TURSO_AUTH_TOKEN: '',
    JWT_PRIVATE_KEY,
    JWT_PUBLIC_KEY,
    ALLOWED_ORIGINS: '*',
  };
});

afterEach(async () => {
  // Delete test data in FK-safe order.
  await cleanupDb.delete(refreshTokens);
  await cleanupDb.delete(customers);
  await cleanupDb.delete(users);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function post(path: string, body: unknown): Promise<Response> {
  return dispatch(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

const REG_BODY = {
  email: 'test@example.com',
  password: 'password123',
  firstName: 'Test',
  lastName: 'User',
};

// ---------------------------------------------------------------------------
// POST /auth/register
// ---------------------------------------------------------------------------

describe('POST /auth/register', () => {
  it('creates an account and returns token pair', async () => {
    const res = await post('/auth/register', REG_BODY);
    expect(res.status).toBe(201);
    const body = await json<{ data: { user: { email: string }; accessToken: string; refreshToken: string } }>(res);
    expect(body.data.user.email).toBe(REG_BODY.email);
    expect(typeof body.data.accessToken).toBe('string');
    expect(typeof body.data.refreshToken).toBe('string');
  });

  it('returns 409 on duplicate email', async () => {
    await post('/auth/register', REG_BODY);
    const res = await post('/auth/register', REG_BODY);
    expect(res.status).toBe(409);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('CONFLICT');
  });

  it('returns 422 when password is too short', async () => {
    const res = await post('/auth/register', { ...REG_BODY, password: 'short' });
    expect(res.status).toBe(422);
  });

  it('returns 422 when email is invalid', async () => {
    const res = await post('/auth/register', { ...REG_BODY, email: 'not-an-email' });
    expect(res.status).toBe(422);
  });

  it('returns 400 on non-JSON body', async () => {
    const res = await dispatch(
      new Request(`${BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

describe('POST /auth/login', () => {
  it('returns a token pair on valid credentials', async () => {
    await post('/auth/register', REG_BODY);
    const res = await post('/auth/login', { email: REG_BODY.email, password: REG_BODY.password });
    expect(res.status).toBe(200);
    const body = await json<{ data: { accessToken: string; refreshToken: string } }>(res);
    expect(typeof body.data.accessToken).toBe('string');
    expect(typeof body.data.refreshToken).toBe('string');
  });

  it('returns 401 on wrong password', async () => {
    await post('/auth/register', REG_BODY);
    const res = await post('/auth/login', { email: REG_BODY.email, password: 'wrongpassword' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for nonexistent email', async () => {
    const res = await post('/auth/login', { email: 'nobody@example.com', password: 'password123' });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------

describe('POST /auth/logout', () => {
  it('returns 204 and revokes the refresh token', async () => {
    await post('/auth/register', REG_BODY);
    const loginRes = await post('/auth/login', { email: REG_BODY.email, password: REG_BODY.password });
    const { data: { refreshToken } } = await json<{ data: { refreshToken: string } }>(loginRes);

    const logoutRes = await post('/auth/logout', { refreshToken });
    expect(logoutRes.status).toBe(204);

    // Token should now be gone — refresh should fail.
    const refreshRes = await post('/auth/refresh', { refreshToken });
    expect(refreshRes.status).toBe(401);
  });

  it('returns 204 even for an unknown token (idempotent)', async () => {
    const res = await post('/auth/logout', { refreshToken: 'a'.repeat(64) });
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/refresh
// ---------------------------------------------------------------------------

describe('POST /auth/refresh', () => {
  it('issues new token pair and invalidates old refresh token', async () => {
    await post('/auth/register', REG_BODY);
    const loginRes = await post('/auth/login', { email: REG_BODY.email, password: REG_BODY.password });
    const { data: { refreshToken: original } } = await json<{ data: { refreshToken: string } }>(loginRes);

    const refreshRes = await post('/auth/refresh', { refreshToken: original });
    expect(refreshRes.status).toBe(200);
    const { data: { accessToken, refreshToken: rotated } } = await json<{
      data: { accessToken: string; refreshToken: string };
    }>(refreshRes);
    expect(typeof accessToken).toBe('string');
    expect(rotated).not.toBe(original);

    // Old token must be revoked.
    const reuseRes = await post('/auth/refresh', { refreshToken: original });
    expect(reuseRes.status).toBe(401);
  });

  it('returns 401 for an invalid token', async () => {
    const res = await post('/auth/refresh', { refreshToken: 'b'.repeat(64) });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired token', async () => {
    // Insert an expired refresh token row directly then try to use it.
    await post('/auth/register', REG_BODY);
    const loginRes = await post('/auth/login', { email: REG_BODY.email, password: REG_BODY.password });
    const { data: { refreshToken } } = await json<{ data: { refreshToken: string } }>(loginRes);
    const hash = await hashToken(refreshToken);

    const { eq } = await import('drizzle-orm');
    // Backdate expiry to force expiration.
    await cleanupDb
      .update(refreshTokens)
      .set({ expiresAt: new Date(0).toISOString() })
      .where(eq(refreshTokens.tokenHash, hash));

    const res = await post('/auth/refresh', { refreshToken });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/forgot-password
// ---------------------------------------------------------------------------

describe('POST /auth/forgot-password', () => {
  it('always returns 200 regardless of whether email exists', async () => {
    const res1 = await post('/auth/forgot-password', { email: 'nobody@example.com' });
    expect(res1.status).toBe(200);

    await post('/auth/register', REG_BODY);
    const res2 = await post('/auth/forgot-password', { email: REG_BODY.email });
    expect(res2.status).toBe(200);

    const body = await json<{ data: { message: string } }>(res2);
    expect(body.data.message).toContain('reset link');
  });

  it('returns 422 for invalid email format', async () => {
    const res = await post('/auth/forgot-password', { email: 'not-email' });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/reset-password
// ---------------------------------------------------------------------------

describe('POST /auth/reset-password', () => {
  it('resets the password with a valid reset token', async () => {
    await post('/auth/register', REG_BODY);

    // Issue a reset token directly (bypasses email delivery).
    const db = getDb(env);
    const userRows = await db.select({ id: users.id }).from(users).where(eq(users.email, REG_BODY.email));
    const resetToken = await issueResetToken(userRows[0].id, db);

    const res = await post('/auth/reset-password', { token: resetToken, newPassword: 'newpassword123' });
    expect(res.status).toBe(200);

    // Old password no longer works.
    const oldLoginRes = await post('/auth/login', { email: REG_BODY.email, password: REG_BODY.password });
    expect(oldLoginRes.status).toBe(401);

    // New password works.
    const newLoginRes = await post('/auth/login', { email: REG_BODY.email, password: 'newpassword123' });
    expect(newLoginRes.status).toBe(200);
  });

  it('returns 401 for an invalid reset token', async () => {
    const res = await post('/auth/reset-password', { token: 'c'.repeat(64), newPassword: 'newpassword123' });
    expect(res.status).toBe(401);
  });

  it('refuses reuse of a reset token', async () => {
    await post('/auth/register', REG_BODY);
    const db = getDb(env);
    const userRows = await db.select({ id: users.id }).from(users).where(eq(users.email, REG_BODY.email));
    const resetToken = await issueResetToken(userRows[0].id, db);

    await post('/auth/reset-password', { token: resetToken, newPassword: 'newpassword123' });

    const res = await post('/auth/reset-password', { token: resetToken, newPassword: 'anotherpass' });
    expect(res.status).toBe(401);
  });
});
