import { describe, it, expect, beforeAll } from 'bun:test';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { AppEnv } from '../types.js';
import { dispatch } from '../router.js';
import '../app.js'; // registers all routes including discovery

let env: AppEnv;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);
  const client = createClient({ url: 'file:local.sqlite' });
  const db = drizzle(client, {});
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  env = {
    ENVIRONMENT: 'development',
    DB_SRC: 'local',
    TURSO_DB_URL: '',
    TURSO_AUTH_TOKEN: '',
    JWT_PRIVATE_KEY: privateKeyPem,
    JWT_PUBLIC_KEY: publicKeyPem,
    ALLOWED_ORIGINS: '*',
  };
});

describe('GET /', () => {
  it('returns 200 with route manifest', async () => {
    const res = await dispatch(new Request('http://localhost/'), env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.name).toBe('LOPC API');
    expect(body.data.routes).toBeArray();
    expect(body.data.routes.length).toBeGreaterThan(0);
  });

  it('includes auth, method, path for each route', async () => {
    const res = await dispatch(new Request('http://localhost/'), env);
    const body = await res.json() as any;
    for (const route of body.data.routes) {
      expect(route.method).toBeString();
      expect(route.path).toBeString();
      expect(route.auth).toBeString();
      expect(route.description).toBeString();
    }
  });

  it('includes expected routes (auth, products, categories)', async () => {
    const res = await dispatch(new Request('http://localhost/'), env);
    const body = await res.json() as any;
    const paths = body.data.routes.map((r: any) => `${r.method} ${r.path}`);
    expect(paths).toContain('POST /auth/register');
    expect(paths).toContain('GET /products');
    expect(paths).toContain('GET /categories');
    expect(paths).toContain('POST /orders');
    expect(paths).toContain('GET /logistics/tracking/:trackingNumber');
  });

  it('has no duplicate method+path combinations', async () => {
    const res = await dispatch(new Request('http://localhost/'), env);
    const body = await res.json() as any;
    const keys = body.data.routes.map((r: any) => `${r.method} ${r.path}`);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });
});
