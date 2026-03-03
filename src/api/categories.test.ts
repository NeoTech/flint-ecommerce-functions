/**
 * Categories API integration tests.
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
import * as schema from '../db/schema.js';
import { issueAccessToken } from '../lib/tokens.js';
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
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
  const JWT_PUBLIC_KEY = await exportSPKI(publicKey);

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
  await cleanupDb.delete(schema.productVariants);
  await cleanupDb.delete(schema.products);
  await cleanupDb.delete(schema.categories);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function get(path: string, headers?: Record<string, string>): Promise<Response> {
  return dispatch(new Request(`${BASE}${path}`, { method: 'GET', headers }), env);
}

function post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return dispatch(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

function put(path: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return dispatch(
    new Request(`${BASE}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

function del(path: string, headers?: Record<string, string>): Promise<Response> {
  return dispatch(new Request(`${BASE}${path}`, { method: 'DELETE', headers }), env);
}

async function adminHeaders(): Promise<Record<string, string>> {
  const token = await issueAccessToken('admin-user-id', 'admin', env);
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// GET /categories
// ---------------------------------------------------------------------------

describe('GET /categories', () => {
  it('returns empty list when no categories exist', async () => {
    const res = await get('/categories');
    expect(res.status).toBe(200);
    const body = await json<{ data: unknown[] }>(res);
    expect(body.data).toBeArray();
    expect(body.data).toHaveLength(0);
  });

  it('returns list of categories sorted by sortOrder then name', async () => {
    const headers = await adminHeaders();
    await post('/categories', { name: 'Clothing', sortOrder: 2 }, headers);
    await post('/categories', { name: 'Electronics', sortOrder: 1 }, headers);

    const res = await get('/categories');
    expect(res.status).toBe(200);
    const body = await json<{ data: Array<{ name: string }> }>(res);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].name).toBe('Electronics');
    expect(body.data[1].name).toBe('Clothing');
  });
});

// ---------------------------------------------------------------------------
// GET /categories/:id
// ---------------------------------------------------------------------------

describe('GET /categories/:id', () => {
  it('returns 404 for nonexistent category', async () => {
    const res = await get('/categories/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns category with children array', async () => {
    const headers = await adminHeaders();
    const parentRes = await post('/categories', { name: 'Electronics', sortOrder: 0 }, headers);
    const parent = await json<{ data: { id: string } }>(parentRes);
    const parentId = parent.data.id;

    await post('/categories', { name: 'Phones', parentId, sortOrder: 0 }, headers);
    await post('/categories', { name: 'Laptops', parentId, sortOrder: 1 }, headers);

    const res = await get(`/categories/${parentId}`);
    expect(res.status).toBe(200);
    const body = await json<{ data: { id: string; children: Array<{ name: string }> } }>(res);
    expect(body.data.id).toBe(parentId);
    expect(body.data.children).toHaveLength(2);
    const childNames = body.data.children.map((c) => c.name);
    expect(childNames).toContain('Phones');
    expect(childNames).toContain('Laptops');
  });

  it('returns category with empty children array when none exist', async () => {
    const headers = await adminHeaders();
    const createRes = await post('/categories', { name: 'Solo', sortOrder: 0 }, headers);
    const created = await json<{ data: { id: string } }>(createRes);

    const res = await get(`/categories/${created.data.id}`);
    expect(res.status).toBe(200);
    const body = await json<{ data: { children: unknown[] } }>(res);
    expect(body.data.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /categories
// ---------------------------------------------------------------------------

describe('POST /categories', () => {
  it('returns 401 without auth', async () => {
    const res = await post('/categories', { name: 'Furniture' });
    expect(res.status).toBe(401);
  });

  it('creates a category and auto-generates slug', async () => {
    const headers = await adminHeaders();
    const res = await post('/categories', { name: 'Home & Garden', sortOrder: 0 }, headers);
    expect(res.status).toBe(201);
    const body = await json<{ data: { name: string; slug: string } }>(res);
    expect(body.data.name).toBe('Home & Garden');
    expect(body.data.slug).toBe('home-garden');
  });

  it('appends counter on duplicate slug', async () => {
    const headers = await adminHeaders();
    await post('/categories', { name: 'Shoes', sortOrder: 0 }, headers);
    const res = await post('/categories', { name: 'Shoes', sortOrder: 1 }, headers);
    expect(res.status).toBe(201);
    const body = await json<{ data: { slug: string } }>(res);
    expect(body.data.slug).toBe('shoes-2');
  });
});

// ---------------------------------------------------------------------------
// PUT /categories/:id
// ---------------------------------------------------------------------------

describe('PUT /categories/:id', () => {
  it('updates category fields', async () => {
    const headers = await adminHeaders();
    const createRes = await post('/categories', { name: 'Gadgets', sortOrder: 0 }, headers);
    const created = await json<{ data: { id: string } }>(createRes);
    const categoryId = created.data.id;

    const res = await put(`/categories/${categoryId}`, { name: 'Tech Gadgets' }, headers);
    expect(res.status).toBe(200);
    const body = await json<{ data: { name: string; slug: string } }>(res);
    expect(body.data.name).toBe('Tech Gadgets');
    expect(body.data.slug).toBe('tech-gadgets');
  });

  it('returns 404 for nonexistent category', async () => {
    const headers = await adminHeaders();
    const res = await put('/categories/nonexistent', { name: 'X' }, headers);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /categories/:id
// ---------------------------------------------------------------------------

describe('DELETE /categories/:id', () => {
  it('deletes category with no active products', async () => {
    const headers = await adminHeaders();
    const createRes = await post('/categories', { name: 'Empty Category', sortOrder: 0 }, headers);
    const created = await json<{ data: { id: string } }>(createRes);
    const categoryId = created.data.id;

    const res = await del(`/categories/${categoryId}`, headers);
    expect(res.status).toBe(204);

    const getRes = await get(`/categories/${categoryId}`);
    expect(getRes.status).toBe(404);
  });

  it('returns 409 when active products reference the category', async () => {
    const headers = await adminHeaders();
    const catRes = await post('/categories', { name: 'Occupied', sortOrder: 0 }, headers);
    const cat = await json<{ data: { id: string } }>(catRes);
    const categoryId = cat.data.id;

    await post('/products', { name: 'Product in Category', price: 10, status: 'active', categoryId }, headers);

    const res = await del(`/categories/${categoryId}`, headers);
    expect(res.status).toBe(409);
  });

  it('returns 404 for nonexistent category', async () => {
    const headers = await adminHeaders();
    const res = await del('/categories/nonexistent', headers);
    expect(res.status).toBe(404);
  });
});
