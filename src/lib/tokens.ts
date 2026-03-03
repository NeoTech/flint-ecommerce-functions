/**
 * Token utilities for auth flows.
 *
 * - Access tokens:  RS256 JWT, 15 min TTL, signed with JWT_PRIVATE_KEY
 * - Refresh tokens: opaque 32-byte hex, SHA-256 hashed before DB storage, 7 day TTL
 * - Reset tokens:   opaque 32-byte hex, SHA-256 hashed before DB storage, 1 hour TTL
 *
 * All token storage uses the refresh_tokens table.
 * type='refresh' — session refresh tokens
 * type='reset'   — password reset tokens (separate namespace, same table)
 */
import { SignJWT, importPKCS8 } from 'jose';
import { and, eq } from 'drizzle-orm';
import { refreshTokens, users } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { AppEnv } from '../types.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

// ---- Helpers ----------------------------------------------------------------

/**
 * Parse a PEM key that may use literal \n (common when stored in .env files)
 * instead of real newline characters.
 */
function parsePem(key: string): string {
  return key.replace(/\\n/g, '\n');
}

/** Generate a cryptographically random opaque token (32 bytes = 64 hex chars). */
export function generateOpaqueToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hash a token to a hex string for safe DB storage. */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- Access tokens ----------------------------------------------------------

/** Issue a signed RS256 JWT access token with 15 min expiry. */
export async function issueAccessToken(userId: string, role: string, env: AppEnv): Promise<string> {
  const privateKey = await importPKCS8(parsePem(env.JWT_PRIVATE_KEY), 'RS256');
  return new SignJWT({ role })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(privateKey);
}

// ---- DB token storage -------------------------------------------------------

/**
 * Insert a hashed opaque token into refresh_tokens.
 * Returns the raw (unhashed) token — only time it is ever in plaintext.
 */
async function storeToken(
  userId: string,
  type: 'refresh' | 'reset',
  ttlMinutes: number,
  db: Db,
): Promise<string> {
  const raw = generateOpaqueToken();
  const tokenHash = await hashToken(raw);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  await db.insert(refreshTokens).values({ userId, tokenHash, type, expiresAt });
  return raw;
}

// ---- Token pair -------------------------------------------------------------

/**
 * Issue a full access + refresh token pair.
 * Access token is a signed JWT; refresh token is stored (hashed) in the DB.
 */
export async function issueTokenPair(
  userId: string,
  role: string,
  env: AppEnv,
  db: Db,
): Promise<TokenPair> {
  const [accessToken, refreshToken] = await Promise.all([
    issueAccessToken(userId, role, env),
    storeToken(userId, 'refresh', 7 * 24 * 60, db),
  ]);
  return { accessToken, refreshToken };
}

// ---- Refresh token rotation -------------------------------------------------

/**
 * Rotate a refresh token:
 *   1. Look up by hash, join users table to get current role
 *   2. Delete the row unconditionally (prevent reuse even if expired)
 *   3. Validate expiry — return null if expired
 *   4. Issue a new token pair
 *
 * Returns null if token is not found, wrong type, or expired.
 */
export async function rotateRefreshToken(
  rawToken: string,
  db: Db,
  env: AppEnv,
): Promise<TokenPair | null> {
  const hash = await hashToken(rawToken);

  const rows = await db
    .select({ rt: refreshTokens, u: users })
    .from(refreshTokens)
    .innerJoin(users, eq(users.id, refreshTokens.userId))
    .where(eq(refreshTokens.tokenHash, hash));

  const row = rows[0];
  if (!row || row.rt.type !== 'refresh') return null;

  // Always delete — prevents reuse.
  await db.delete(refreshTokens).where(eq(refreshTokens.id, row.rt.id));

  if (new Date(row.rt.expiresAt) < new Date()) return null;

  return issueTokenPair(row.u.id, row.u.role, env, db);
}

/** Revoke (delete) a refresh token by raw value. No-op if not found. */
export async function revokeRefreshToken(rawToken: string, db: Db): Promise<void> {
  const hash = await hashToken(rawToken);
  await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, hash));
}

// ---- Password reset token ---------------------------------------------------

/**
 * Issue a password reset token (1h TTL).
 * Any existing reset tokens for this user are deleted first to prevent accumulation.
 */
export async function issueResetToken(userId: string, db: Db): Promise<string> {
  await db
    .delete(refreshTokens)
    .where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.type, 'reset')));
  return storeToken(userId, 'reset', 60, db);
}

/**
 * Consume a password reset token.
 * Returns the userId if valid; null if not found, wrong type, or expired.
 * Always deletes the row to prevent reuse.
 */
export async function consumeResetToken(rawToken: string, db: Db): Promise<string | null> {
  const hash = await hashToken(rawToken);

  const rows = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hash));

  const row = rows[0];
  if (!row || row.type !== 'reset') return null;

  // Always delete — prevents reuse even if expired.
  await db.delete(refreshTokens).where(eq(refreshTokens.id, row.id));

  if (new Date(row.expiresAt) < new Date()) return null;

  return row.userId;
}
