/**
 * Products and Variants API integration tests.
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
// GET /products
// ---------------------------------------------------------------------------

describe('GET /products', () => {
  it('returns only active products by default', async () => {
    const headers = await adminHeaders();
    await post('/products', { name: 'Active Product', price: 10, status: 'active' }, headers);
    await post('/products', { name: 'Draft Product', price: 20, status: 'draft' }, headers);

    const res = await get('/products');
    expect(res.status).toBe(200);
    const body = await json<{ data: Array<{ name: string; status: string }> }>(res);
    expect(body.data.every((p) => p.status === 'active')).toBe(true);
  });

  it('filters by search term', async () => {
    const headers = await adminHeaders();
    await post('/products', { name: 'Apple Juice', price: 5, status: 'active' }, headers);
    await post('/products', { name: 'Orange Juice', price: 6, status: 'active' }, headers);

    const res = await get('/products?search=Apple');
    expect(res.status).toBe(200);
    const body = await json<{ data: Array<{ name: string }> }>(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Apple Juice');
  });

  it('filters by inStock=true', async () => {
    const headers = await adminHeaders();
    await post('/products', { name: 'In Stock', price: 5, stock: 10, status: 'active' }, headers);
    await post('/products', { name: 'Out of Stock', price: 5, stock: 0, status: 'active' }, headers);

    const res = await get('/products?inStock=true');
    expect(res.status).toBe(200);
    const body = await json<{ data: Array<{ name: string }> }>(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('In Stock');
  });

  it('returns pagination meta', async () => {
    const headers = await adminHeaders();
    await post('/products', { name: 'Product A', price: 5, status: 'active' }, headers);

    const res = await get('/products?page=1&pageSize=10');
    expect(res.status).toBe(200);
    const body = await json<{ data: unknown[]; meta: { page: number; pageSize: number; total: number } }>(res);
    expect(body.meta.page).toBe(1);
    expect(body.meta.pageSize).toBe(10);
    expect(typeof body.meta.total).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// GET /products/:id
// ---------------------------------------------------------------------------

describe('GET /products/:id', () => {
  it('returns 404 for nonexistent product', async () => {
    const res = await get('/products/nonexistent-id');
    expect(res.status).toBe(404);
  });

  it('returns 404 for archived product without auth', async () => {
    const headers = await adminHeaders();
    const createRes = await post('/products', { name: 'Old Product', price: 5, status: 'active' }, headers);
    const created = await json<{ data: { id: string } }>(createRes);
    const productId = created.data.id;

    await del(`/products/${productId}`, headers);

    const res = await get(`/products/${productId}`);
    expect(res.status).toBe(404);
  });

  it('returns product with variants for existing product', async () => {
    const headers = await adminHeaders();
    const createRes = await post('/products', { name: 'Widget', price: 25, status: 'active' }, headers);
    const created = await json<{ data: { id: string } }>(createRes);
    const productId = created.data.id;

    const res = await get(`/products/${productId}`);
    expect(res.status).toBe(200);
    const body = await json<{ data: { id: string; variants: unknown[] } }>(res);
    expect(body.data.id).toBe(productId);
    expect(Array.isArray(body.data.variants)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /products
// ---------------------------------------------------------------------------

describe('POST /products', () => {
  it('returns 401 without auth', async () => {
    const res = await post('/products', { name: 'Widget', price: 10 });
    expect(res.status).toBe(401);
  });

  it('creates a product and returns 201', async () => {
    const headers = await adminHeaders();
    const res = await post('/products', { name: 'New Widget', price: 29.99, status: 'active' }, headers);
    expect(res.status).toBe(201);
    const body = await json<{ data: { id: string; name: string; slug: string } }>(res);
    expect(body.data.name).toBe('New Widget');
    expect(body.data.slug).toBe('new-widget');
  });

  it('auto-generates slug from name', async () => {
    const headers = await adminHeaders();
    const res = await post('/products', { name: 'My Cool Product!', price: 10, status: 'active' }, headers);
    expect(res.status).toBe(201);
    const body = await json<{ data: { slug: string } }>(res);
    expect(body.data.slug).toBe('my-cool-product');
  });

  it('appends counter on duplicate slug', async () => {
    const headers = await adminHeaders();
    await post('/products', { name: 'Widget', price: 10, status: 'active' }, headers);
    const res = await post('/products', { name: 'Widget', price: 20, status: 'active' }, headers);
    expect(res.status).toBe(201);
    const body = await json<{ data: { slug: string } }>(res);
    expect(body.data.slug).toBe('widget-2');
  });
});

// ---------------------------------------------------------------------------
// PUT /products/:id
// ---------------------------------------------------------------------------

describe('PUT /products/:id', () => {
  it('updates product fields', async () => {
    const headers = await adminHeaders();
    const createRes = await post('/products', { name: 'Widget', price: 10, status: 'active' }, headers);
    const created = await json<{ data: { id: string } }>(createRes);
    const productId = created.data.id;

    const res = await put(`/products/${productId}`, { price: 99 }, headers);
    expect(res.status).toBe(200);
    const body = await json<{ data: { price: number } }>(res);
    expect(body.data.price).toBe(99);
  });

  it('returns 404 for nonexistent product', async () => {
    const headers = await adminHeaders();
    const res = await put('/products/nonexistent', { price: 5 }, headers);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /products/:id
// ---------------------------------------------------------------------------

describe('DELETE /products/:id', () => {
  it('soft-deletes product and re-GET returns 404', async () => {
    const headers = await adminHeaders();
    const createRes = await post('/products', { name: 'Deletable', price: 5, status: 'active' }, headers);
    const created = await json<{ data: { id: string } }>(createRes);
    const productId = created.data.id;

    const delRes = await del(`/products/${productId}`, headers);
    expect(delRes.status).toBe(204);

    const getRes = await get(`/products/${productId}`);
    expect(getRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /products/:id/variants
// ---------------------------------------------------------------------------

describe('GET /products/:id/variants', () => {
  it('returns 404 for nonexistent product', async () => {
    const res = await get('/products/nonexistent/variants');
    expect(res.status).toBe(404);
  });

  it('lists variants for a product', async () => {
    const headers = await adminHeaders();
    const createRes = await post('/products', { name: 'Widget', price: 10, status: 'active' }, headers);
    const created = await json<{ data: { id: string } }>(createRes);
    const productId = created.data.id;

    await post(`/products/${productId}/variants`, { sku: 'W-RED', name: 'Red' }, headers);

    const res = await get(`/products/${productId}/variants`);
    expect(res.status).toBe(200);
    const body = await json<{ data: Array<{ sku: string }> }>(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].sku).toBe('W-RED');
  });
});

// ---------------------------------------------------------------------------
// POST /products/:id/variants
// ---------------------------------------------------------------------------

describe('POST /products/:id/variants', () => {
  it('adds a variant and returns 201', async () => {
    const headers = await adminHeaders();
    const createRes = await post('/products', { name: 'Widget', price: 10, status: 'active' }, headers);
    const created = await json<{ data: { id: string } }>(createRes);
    const productId = created.data.id;

    const res = await post(`/products/${productId}/variants`, { sku: 'W-BLUE-L', name: 'Blue Large' }, headers);
    expect(res.status).toBe(201);
    const body = await json<{ data: { sku: string; name: string } }>(res);
    expect(body.data.sku).toBe('W-BLUE-L');
    expect(body.data.name).toBe('Blue Large');
  });

  it('returns 409 on duplicate SKU', async () => {
    const headers = await adminHeaders();
    const createRes = await post('/products', { name: 'Widget', price: 10, status: 'active' }, headers);
    const created = await json<{ data: { id: string } }>(createRes);
    const productId = created.data.id;

    await post(`/products/${productId}/variants`, { sku: 'DUP-SKU', name: 'First' }, headers);
    const res = await post(`/products/${productId}/variants`, { sku: 'DUP-SKU', name: 'Second' }, headers);
    expect(res.status).toBe(409);
  });

  it('returns 404 if product does not exist', async () => {
    const headers = await adminHeaders();
    const res = await post('/products/nonexistent/variants', { sku: 'X', name: 'X' }, headers);
    expect(res.status).toBe(404);
  });
});
