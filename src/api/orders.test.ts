/**
 * Orders API integration tests.
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
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../types.js';
import { dispatch } from '../router.js';
import { issueAccessToken } from '../lib/tokens.js';
import '../app.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let env: AppEnv;
let cleanupDb: ReturnType<typeof drizzle>;
let adminToken: string;

const BASE = 'https://test.local';
// Fixed admin user ID used only to sign tokens — not inserted into DB.
const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000001';

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
  const JWT_PUBLIC_KEY  = await exportSPKI(publicKey);

  const client = createClient({ url: 'file:local.sqlite' });
  cleanupDb = drizzle(client, {});
  await migrate(cleanupDb, { migrationsFolder: './src/db/migrations' });

  env = {
    ENVIRONMENT:     'development',
    DB_SRC:          'local',
    TURSO_DB_URL:    '',
    TURSO_AUTH_TOKEN: '',
    JWT_PRIVATE_KEY,
    JWT_PUBLIC_KEY,
    ALLOWED_ORIGINS: '*',
  };

  adminToken = await issueAccessToken(ADMIN_USER_ID, 'admin', env);
});

afterEach(async () => {
  await cleanupDb.delete(schema.orderLines);
  await cleanupDb.delete(schema.shipments);
  await cleanupDb.delete(schema.orders);
  await cleanupDb.delete(schema.productVariants);
  await cleanupDb.delete(schema.products);
  await cleanupDb.delete(schema.addresses);
  await cleanupDb.delete(schema.refreshTokens);
  await cleanupDb.delete(schema.customers);
  await cleanupDb.delete(schema.users);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createCustomer(email: string, password = 'password123') {
  await dispatch(
    new Request(`${BASE}/auth/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password, firstName: 'Test', lastName: 'User' }),
    }),
    env,
  );
  const dbUsers = await cleanupDb
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email));
  const dbCustomers = await cleanupDb.select().from(schema.customers);
  const userId     = dbUsers[0].id;
  const customerId = dbCustomers.find((c: typeof schema.customers.$inferSelect) => c.userId === userId)!.id;
  return { userId, customerId };
}

async function createProduct(name: string, price: number, stock: number, status = 'active') {
  const res = await dispatch(
    new Request(`${BASE}/products`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body:    JSON.stringify({ name, price, stock, status }),
    }),
    env,
  );
  const body = await res.json() as { data: typeof schema.products.$inferSelect };
  return body.data;
}

async function createAddress(customerId: string, userId: string) {
  const token = await issueAccessToken(userId, 'customer', env);
  const res = await dispatch(
    new Request(`${BASE}/customers/${customerId}/addresses`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ street: '123 Main St', city: 'Anytown', postalCode: '12345', country: 'US' }),
    }),
    env,
  );
  const body = await res.json() as { data: typeof schema.addresses.$inferSelect };
  return body.data;
}

async function createOrder(
  userId: string,
  lines: Array<{ productId: string; variantId?: string; quantity: number }>,
  shippingAddressId: string,
  notes?: string,
) {
  const token = await issueAccessToken(userId, 'customer', env);
  return dispatch(
    new Request(`${BASE}/orders`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ lines, shippingAddressId, notes }),
    }),
    env,
  );
}

// ---------------------------------------------------------------------------
// POST /orders
// ---------------------------------------------------------------------------

describe('POST /orders', () => {
  it('creates an order and decrements product stock', async () => {
    const { userId, customerId } = await createCustomer('buyer1@test.com');
    const product = await createProduct('Widget', 10.00, 5);
    const address = await createAddress(customerId, userId);

    const res = await createOrder(userId, [{ productId: product.id, quantity: 2 }], address.id);
    expect(res.status).toBe(201);

    const body = await res.json() as any;
    expect(body.data.customerId).toBe(customerId);
    expect(body.data.subtotal).toBe(20);
    expect(body.data.lines).toHaveLength(1);
    expect(body.data.lines[0].quantity).toBe(2);

    // Stock should be decremented by 2
    const dbProduct = await cleanupDb
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, product.id));
    expect(dbProduct[0].stock).toBe(3);
  });

  it('returns 422 when quantity exceeds available stock', async () => {
    const { userId, customerId } = await createCustomer('buyer2@test.com');
    const product = await createProduct('LowStock', 5.00, 1);
    const address = await createAddress(customerId, userId);

    const res = await createOrder(userId, [{ productId: product.id, quantity: 5 }], address.id);
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// GET /orders
// ---------------------------------------------------------------------------

describe('GET /orders', () => {
  it('customer sees only their own orders', async () => {
    const { userId: u1, customerId: c1 } = await createCustomer('list1@test.com');
    const { userId: u2, customerId: c2 } = await createCustomer('list2@test.com');
    const product = await createProduct('ItemA', 10.00, 10);
    const addr1   = await createAddress(c1, u1);
    const addr2   = await createAddress(c2, u2);

    await createOrder(u1, [{ productId: product.id, quantity: 1 }], addr1.id);
    await createOrder(u2, [{ productId: product.id, quantity: 1 }], addr2.id);

    const token = await issueAccessToken(u1, 'customer', env);
    const res   = await dispatch(
      new Request(`${BASE}/orders`, { headers: { Authorization: `Bearer ${token}` } }),
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].customerId).toBe(c1);
  });

  it('admin sees all orders', async () => {
    const { userId: u1, customerId: c1 } = await createCustomer('admin1@test.com');
    const { userId: u2, customerId: c2 } = await createCustomer('admin2@test.com');
    const product = await createProduct('ItemB', 10.00, 10);
    const addr1   = await createAddress(c1, u1);
    const addr2   = await createAddress(c2, u2);

    await createOrder(u1, [{ productId: product.id, quantity: 1 }], addr1.id);
    await createOrder(u2, [{ productId: product.id, quantity: 1 }], addr2.id);

    const res = await dispatch(
      new Request(`${BASE}/orders`, { headers: { Authorization: `Bearer ${adminToken}` } }),
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// GET /orders/:id
// ---------------------------------------------------------------------------

describe('GET /orders/:id', () => {
  it('owner can access their own order with lines and shipments included', async () => {
    const { userId, customerId } = await createCustomer('owner1@test.com');
    const product = await createProduct('Thing', 15.00, 5);
    const address = await createAddress(customerId, userId);

    const createRes = await createOrder(userId, [{ productId: product.id, quantity: 1 }], address.id);
    const createBody = await createRes.json() as any;
    const orderId = createBody.data.id;

    const token = await issueAccessToken(userId, 'customer', env);
    const res   = await dispatch(
      new Request(`${BASE}/orders/${orderId}`, { headers: { Authorization: `Bearer ${token}` } }),
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.id).toBe(orderId);
    expect(body.data.lines).toHaveLength(1);
    expect(body.data.shipments).toBeArray();
  });

  it('returns 403 when a different customer tries to access the order', async () => {
    const { userId: u1, customerId: c1 } = await createCustomer('owner2@test.com');
    const { userId: u2 }                 = await createCustomer('other@test.com');
    const product = await createProduct('Gizmo', 10.00, 5);
    const address = await createAddress(c1, u1);

    const createRes = await createOrder(u1, [{ productId: product.id, quantity: 1 }], address.id);
    const createBody = await createRes.json() as any;
    const orderId = createBody.data.id;

    const token = await issueAccessToken(u2, 'customer', env);
    const res   = await dispatch(
      new Request(`${BASE}/orders/${orderId}`, { headers: { Authorization: `Bearer ${token}` } }),
      env,
    );

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// PUT /orders/:id/status
// ---------------------------------------------------------------------------

describe('PUT /orders/:id/status', () => {
  it('accepts a valid pending to confirmed transition', async () => {
    const { userId, customerId } = await createCustomer('stat1@test.com');
    const product = await createProduct('ProdA', 10.00, 5);
    const address = await createAddress(customerId, userId);

    const createRes  = await createOrder(userId, [{ productId: product.id, quantity: 1 }], address.id);
    const createBody = await createRes.json() as any;
    const orderId    = createBody.data.id;

    const res = await dispatch(
      new Request(`${BASE}/orders/${orderId}/status`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body:    JSON.stringify({ status: 'confirmed' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('confirmed');
  });

  it('returns 422 for an invalid transition', async () => {
    const { userId, customerId } = await createCustomer('stat2@test.com');
    const product = await createProduct('ProdB', 10.00, 5);
    const address = await createAddress(customerId, userId);

    const createRes  = await createOrder(userId, [{ productId: product.id, quantity: 1 }], address.id);
    const createBody = await createRes.json() as any;
    const orderId    = createBody.data.id;

    // pending -> shipped is not a valid transition
    const res = await dispatch(
      new Request(`${BASE}/orders/${orderId}/status`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body:    JSON.stringify({ status: 'shipped' }),
      }),
      env,
    );

    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// DELETE /orders/:id
// ---------------------------------------------------------------------------

describe('DELETE /orders/:id', () => {
  it('owner can cancel a pending order within 30 minutes and stock is restored', async () => {
    const { userId, customerId } = await createCustomer('cancel1@test.com');
    const product = await createProduct('CancelProd', 10.00, 5);
    const address = await createAddress(customerId, userId);

    const createRes  = await createOrder(userId, [{ productId: product.id, quantity: 2 }], address.id);
    const createBody = await createRes.json() as any;
    const orderId    = createBody.data.id;

    const token = await issueAccessToken(userId, 'customer', env);
    const res   = await dispatch(
      new Request(`${BASE}/orders/${orderId}`, {
        method:  'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );

    expect(res.status).toBe(204);

    // Stock should be fully restored
    const dbProduct = await cleanupDb
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, product.id));
    expect(dbProduct[0].stock).toBe(5);
  });

  it('owner cannot cancel a confirmed order', async () => {
    const { userId, customerId } = await createCustomer('cancel2@test.com');
    const product = await createProduct('CancelProd2', 10.00, 5);
    const address = await createAddress(customerId, userId);

    const createRes  = await createOrder(userId, [{ productId: product.id, quantity: 1 }], address.id);
    const createBody = await createRes.json() as any;
    const orderId    = createBody.data.id;

    // Advance to confirmed via admin
    await dispatch(
      new Request(`${BASE}/orders/${orderId}/status`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body:    JSON.stringify({ status: 'confirmed' }),
      }),
      env,
    );

    const token = await issueAccessToken(userId, 'customer', env);
    const res   = await dispatch(
      new Request(`${BASE}/orders/${orderId}`, {
        method:  'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /orders/:id/refund
// ---------------------------------------------------------------------------

describe('POST /orders/:id/refund', () => {
  it('admin can refund a full order and status becomes refunded', async () => {
    const { userId, customerId } = await createCustomer('refund1@test.com');
    const product = await createProduct('RefundProd', 50.00, 5);
    const address = await createAddress(customerId, userId);

    const createRes  = await createOrder(userId, [{ productId: product.id, quantity: 1 }], address.id);
    const createBody = await createRes.json() as any;
    const orderId    = createBody.data.id;

    // Advance to delivered
    for (const status of ['confirmed', 'processing', 'shipped', 'delivered']) {
      await dispatch(
        new Request(`${BASE}/orders/${orderId}/status`, {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
          body:    JSON.stringify({ status }),
        }),
        env,
      );
    }

    const res = await dispatch(
      new Request(`${BASE}/orders/${orderId}/refund`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body:    JSON.stringify({ amount: 50, reason: 'Customer request' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('refunded');
    expect(body.data.refundedAmount).toBe(50);
  });
});
