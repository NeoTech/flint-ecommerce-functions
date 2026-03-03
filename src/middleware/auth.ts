/**
 * Auth middleware — JWT RS256 validation.
 *
 * Reads the Authorization: Bearer <token> header, verifies the JWT using
 * the RS256 public key from env.JWT_PUBLIC_KEY, and returns the decoded
 * payload fields needed by the router.
 *
 * JWT claims expected:
 *   sub  — userId (string)
 *   role — 'customer' | 'admin'
 *   Standard claims: exp, iat, iss (all enforced by jose automatically when present)
 */
import { importSPKI, jwtVerify } from 'jose';
import type { AppEnv } from '../types.js';

export interface AuthPayload {
  userId: string;
  role: 'customer' | 'admin';
}

/**
 * Validate the Bearer token in the request.
 * Returns the auth payload on success, or null if the token is missing,
 * malformed, expired, or fails RS256 signature verification.
 */
export async function validateBearerToken(
  request: Request,
  env: AppEnv,
): Promise<AuthPayload | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  if (!env.JWT_PUBLIC_KEY) return null;

  try {
    const publicKey = await importSPKI(env.JWT_PUBLIC_KEY, 'RS256');
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ['RS256'],
    });

    // Accept userId from `sub` (standard) or `userId` claim (legacy).
    const userId = (payload.sub ?? (payload['userId'] as string | undefined)) ?? '';
    const role = payload['role'] as string | undefined;

    if (!userId || !role || (role !== 'customer' && role !== 'admin')) {
      return null;
    }

    return { userId, role };
  } catch {
    // Covers: expired, bad signature, malformed token, key import failure.
    return null;
  }
}
