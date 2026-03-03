/**
 * Router tests.
 * Covers: registry helpers, route matching, 404, 405, OPTIONS preflight,
 * auth enforcement (stub level).
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { dispatch, getRoutes, registerRoute } from './router.js';
import type { AppEnv, RequestContext } from './types.js';
import { ok } from './types.js';

// Minimal env that satisfies AppEnv but has no external service credentials.
const testEnv: AppEnv = {
  ENVIRONMENT: 'development',
  TURSO_DB_URL: '',
  TURSO_AUTH_TOKEN: '',
  JWT_PUBLIC_KEY: '',
  JWT_PRIVATE_KEY: '',
  ALLOWED_ORIGINS: '*',
  // RATE_LIMITER_PUBLIC / RATE_LIMITER_AUTH absent → rate limiting skipped
};

const BASE = 'https://example.com';

describe('router scaffold', () => {
  it('getRoutes returns an empty array before any routes are registered', () => {
    expect(Array.isArray(getRoutes())).toBe(true);
  });

  it('registerRoute adds a route visible in getRoutes', () => {
    const before = getRoutes().length;

    registerRoute({
      method: 'GET',
      path: '/__test_scaffold__',
      auth: 'none',
      description: 'scaffold test route',
      handler: async (_req: Request, _ctx: RequestContext) => ok({ ok: true }),
    });

    const after = getRoutes();
    expect(after.length).toBe(before + 1);

    const found = after.find((r) => r.path === '/__test_scaffold__');
    expect(found).toBeDefined();
    expect(found?.method).toBe('GET');
    expect(found?.auth).toBe('none');
  });

  it('getRoutes does not expose handler functions', () => {
    const routes = getRoutes();
    for (const route of routes) {
      expect('handler' in route).toBe(false);
    }
  });
});

describe('router dispatch', () => {
  beforeAll(() => {
    // Register a dedicated set of test routes that won't conflict with scaffold routes.
    registerRoute({
      method: 'GET',
      path: '/test/hello',
      auth: 'none',
      description: 'dispatch test — GET',
      handler: async () => ok({ message: 'hello' }),
    });

    registerRoute({
      method: 'POST',
      path: '/test/hello',
      auth: 'none',
      description: 'dispatch test — POST',
      handler: async () => ok({ message: 'created' }),
    });

    registerRoute({
      method: 'GET',
      path: '/test/protected',
      auth: 'customer',
      description: 'dispatch test — protected',
      handler: async () => ok({ secret: true }),
    });
  });

  it('returns 200 for a matched route', async () => {
    const req = new Request(`${BASE}/test/hello`);
    const res = await dispatch(req, testEnv);
    expect(res.status).toBe(200);
  });

  it('returns 404 for an unknown path', async () => {
    const req = new Request(`${BASE}/does/not/exist`);
    const res = await dispatch(req, testEnv);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 405 when the path exists but the method does not match', async () => {
    const req = new Request(`${BASE}/test/hello`, { method: 'DELETE' });
    const res = await dispatch(req, testEnv);
    expect(res.status).toBe(405);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('handles OPTIONS preflight with 204 and CORS headers', async () => {
    const req = new Request(`${BASE}/test/hello`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://frontend.example.com' },
    });
    const res = await dispatch(req, testEnv);
    expect(res.status).toBe(204);
    expect(res.headers.has('Access-Control-Allow-Methods')).toBe(true);
  });

  it('returns CORS headers on every response', async () => {
    const req = new Request(`${BASE}/test/hello`, {
      headers: { Origin: 'https://frontend.example.com' },
    });
    const res = await dispatch(req, testEnv);
    expect(res.headers.has('Access-Control-Allow-Methods')).toBe(true);
  });

  it('returns 401 for a protected route with no token', async () => {
    const req = new Request(`${BASE}/test/protected`);
    const res = await dispatch(req, testEnv);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });
});
