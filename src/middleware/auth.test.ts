/**
 * Unit tests for validateBearerToken.
 *
 * Generates a real RS256 key pair at test startup — no network calls required.
 * All token signing is done in-process using jose.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { type GenerateKeyPairResult, exportSPKI, generateKeyPair, SignJWT } from 'jose';
import type { AppEnv } from '../types.js';
import { validateBearerToken } from './auth.js';

// ---------------------------------------------------------------------------
// Shared key pair — generated once for the full suite.
// ---------------------------------------------------------------------------

let keys: GenerateKeyPairResult;
let publicKeyPem: string;

const BASE_ENV: AppEnv = {
  ENVIRONMENT: 'development',
  TURSO_DB_URL: '',
  TURSO_AUTH_TOKEN: '',
  JWT_PUBLIC_KEY: '',
  JWT_PRIVATE_KEY: '',
  ALLOWED_ORIGINS: '*',
};

function makeRequest(token?: string): Request {
  const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
  return new Request('https://example.com/test', { headers });
}

async function signToken(
  payload: Record<string, unknown>,
  expiresIn: string | number = '15m',
): Promise<string> {
  let builder = new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setSubject(String(payload['userId'] ?? payload['sub'] ?? 'test-user'));

  if (typeof expiresIn === 'string') {
    builder = builder.setExpirationTime(expiresIn);
  }

  return builder.sign(keys.privateKey);
}

// ---------------------------------------------------------------------------

describe('validateBearerToken', () => {
  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
    publicKeyPem = await exportSPKI(keys.publicKey);
  });

  it('returns null when Authorization header is missing', async () => {
    const env: AppEnv = { ...BASE_ENV, JWT_PUBLIC_KEY: publicKeyPem };
    const result = await validateBearerToken(makeRequest(), env);
    expect(result).toBeNull();
  });

  it('returns null when Authorization header does not start with Bearer', async () => {
    const env: AppEnv = { ...BASE_ENV, JWT_PUBLIC_KEY: publicKeyPem };
    const req = new Request('https://example.com/test', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    const result = await validateBearerToken(req, env);
    expect(result).toBeNull();
  });

  it('returns null when JWT_PUBLIC_KEY is empty', async () => {
    const token = await signToken({ role: 'customer', userId: 'u1' });
    const result = await validateBearerToken(makeRequest(token), BASE_ENV);
    expect(result).toBeNull();
  });

  it('returns null for a malformed token string', async () => {
    const env: AppEnv = { ...BASE_ENV, JWT_PUBLIC_KEY: publicKeyPem };
    const result = await validateBearerToken(makeRequest('not.a.jwt'), env);
    expect(result).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const env: AppEnv = { ...BASE_ENV, JWT_PUBLIC_KEY: publicKeyPem };
    // expiresAt in the past
    const token = await new SignJWT({ role: 'customer' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .setSubject('u-expired')
      .sign(keys.privateKey);

    const result = await validateBearerToken(makeRequest(token), env);
    expect(result).toBeNull();
  });

  it('returns null when role claim is missing', async () => {
    const env: AppEnv = { ...BASE_ENV, JWT_PUBLIC_KEY: publicKeyPem };
    const token = await signToken({ userId: 'u-no-role' });
    const result = await validateBearerToken(makeRequest(token), env);
    expect(result).toBeNull();
  });

  it('returns null when role claim is invalid', async () => {
    const env: AppEnv = { ...BASE_ENV, JWT_PUBLIC_KEY: publicKeyPem };
    const token = await signToken({ userId: 'u-bad-role', role: 'superuser' });
    const result = await validateBearerToken(makeRequest(token), env);
    expect(result).toBeNull();
  });

  it('returns payload for a valid customer token', async () => {
    const env: AppEnv = { ...BASE_ENV, JWT_PUBLIC_KEY: publicKeyPem };
    const token = await signToken({ userId: 'user-123', role: 'customer' });
    const result = await validateBearerToken(makeRequest(token), env);
    expect(result).toEqual({ userId: 'user-123', role: 'customer' });
  });

  it('returns payload for a valid admin token', async () => {
    const env: AppEnv = { ...BASE_ENV, JWT_PUBLIC_KEY: publicKeyPem };
    const token = await signToken({ userId: 'admin-456', role: 'admin' });
    const result = await validateBearerToken(makeRequest(token), env);
    expect(result).toEqual({ userId: 'admin-456', role: 'admin' });
  });

  it('accepts userId from the sub claim when userId claim is absent', async () => {
    const env: AppEnv = { ...BASE_ENV, JWT_PUBLIC_KEY: publicKeyPem };
    const token = await new SignJWT({ role: 'customer' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setExpirationTime('15m')
      .setSubject('sub-only-user')
      .sign(keys.privateKey);

    const result = await validateBearerToken(makeRequest(token), env);
    expect(result).toEqual({ userId: 'sub-only-user', role: 'customer' });
  });

  it('returns null when token is signed with a different private key', async () => {
    const env: AppEnv = { ...BASE_ENV, JWT_PUBLIC_KEY: publicKeyPem };
    // Sign with a completely different key
    const { privateKey: otherPrivateKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setExpirationTime('15m')
      .setSubject('tampered-user')
      .sign(otherPrivateKey);

    const result = await validateBearerToken(makeRequest(token), env);
    expect(result).toBeNull();
  });
});
