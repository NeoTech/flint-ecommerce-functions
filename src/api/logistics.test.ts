/**
 * Logistics / Shipments API integration tests.
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
const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000001';

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
  const JWT_PUBLIC_KEY  = await exportSPKI(publicKey);

  const client = createClient({ url: 'file:local.sqlite' });
  cleanupDb = drizzle(client, {});
  await migrate(cleanupDb, { migrationsFolder: './src/db/migrations' });

  env = {
    ENVIRONMENT:      'development',
    DB_SRC:           'local',
    TURSO_DB_URL:     '',
    TURSO_AUTH_TOKEN: '',
    JWT_PRIVATE_KEY,
    JWT_PUBLIC_KEY,
    ALLOWED_ORIGINS:  '*',
  };

  adminToken = await issueAccessToken(ADMIN_USER_ID, 'admin', env);
});

afterEach(async () => {
  await cleanupDb.delete(schema.shipments);
  await cleanupDb.delete(schema.orderLines);
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

async function setupOrderAndCustomer() {
  const userId     = crypto.randomUUID();
  const customerId = crypto.randomUUID();
  const orderId    = crypto.randomUUID();

  await cleanupDb.insert(schema.users).values({
    id: userId, email: 'test@test.com', passwordHash: 'x', role: 'customer',
  });
  await cleanupDb.insert(schema.customers).values({
    id: customerId, userId, firstName: 'Test', lastName: 'User',
  });
  await cleanupDb.insert(schema.orders).values({
    id: orderId, customerId, status: 'processing', subtotal: 10, total: 10,
  });

  return { userId, customerId, orderId };
}

async function createShipment(orderId: string, trackingNumber = 'TRK-001', carrier = 'FedEx') {
  const res = await dispatch(
    new Request(`${BASE}/logistics/shipments`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body:    JSON.stringify({ orderId, carrier, trackingNumber }),
    }),
    env,
  );
  const body = await res.json() as { data: typeof schema.shipments.$inferSelect };
  return { res, shipment: body.data };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /logistics/shipments', () => {
  it('creates a shipment and auto-advances order to shipped', async () => {
    const { orderId } = await setupOrderAndCustomer();

    const res = await dispatch(
      new Request(`${BASE}/logistics/shipments`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body:    JSON.stringify({ orderId, carrier: 'UPS', trackingNumber: 'TRK-100' }),
      }),
      env,
    );

    expect(res.status).toBe(201);
    const body = await res.json() as { data: typeof schema.shipments.$inferSelect };
    expect(body.data.orderId).toBe(orderId);
    expect(body.data.carrier).toBe('UPS');
    expect(body.data.trackingNumber).toBe('TRK-100');
    expect(body.data.status).toBe('preparing');

    // Order should have advanced to 'shipped'
    const orderRows = await cleanupDb
      .select({ status: schema.orders.status })
      .from(schema.orders)
      .where(require('drizzle-orm').eq(schema.orders.id, orderId));
    expect(orderRows[0]?.status).toBe('shipped');
  });

  it('returns 409 on duplicate trackingNumber', async () => {
    const { orderId } = await setupOrderAndCustomer();
    await createShipment(orderId, 'TRK-DUP');

    // Need a second order to attempt second insert
    const userId2     = crypto.randomUUID();
    const customerId2 = crypto.randomUUID();
    const orderId2    = crypto.randomUUID();
    await cleanupDb.insert(schema.users).values({ id: userId2, email: 'two@test.com', passwordHash: 'x', role: 'customer' });
    await cleanupDb.insert(schema.customers).values({ id: customerId2, userId: userId2, firstName: 'Two', lastName: 'User' });
    await cleanupDb.insert(schema.orders).values({ id: orderId2, customerId: customerId2, status: 'processing', subtotal: 5, total: 5 });

    const res = await dispatch(
      new Request(`${BASE}/logistics/shipments`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body:    JSON.stringify({ orderId: orderId2, carrier: 'FedEx', trackingNumber: 'TRK-DUP' }),
      }),
      env,
    );

    expect(res.status).toBe(409);
  });

  it('returns 404 for nonexistent orderId', async () => {
    const res = await dispatch(
      new Request(`${BASE}/logistics/shipments`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body:    JSON.stringify({ orderId: crypto.randomUUID(), carrier: 'DHL', trackingNumber: 'TRK-GHOST' }),
      }),
      env,
    );

    expect(res.status).toBe(404);
  });
});

describe('GET /logistics/shipments', () => {
  it('admin gets paginated list of shipments', async () => {
    const { orderId } = await setupOrderAndCustomer();
    await createShipment(orderId, 'TRK-LIST-1');

    const res = await dispatch(
      new Request(`${BASE}/logistics/shipments`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; meta: { total: number } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(typeof body.meta.total).toBe('number');
  });
});

describe('GET /logistics/shipments/:id', () => {
  it('owner can access their own shipment', async () => {
    const { userId, orderId } = await setupOrderAndCustomer();
    const { shipment } = await createShipment(orderId, 'TRK-OWN');

    const customerToken = await issueAccessToken(userId, 'customer', env);

    const res = await dispatch(
      new Request(`${BASE}/logistics/shipments/${shipment.id}`, {
        headers: { Authorization: `Bearer ${customerToken}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { data: typeof schema.shipments.$inferSelect };
    expect(body.data.id).toBe(shipment.id);
  });

  it('returns 403 for a customer who does not own the shipment', async () => {
    const { orderId } = await setupOrderAndCustomer();
    const { shipment } = await createShipment(orderId, 'TRK-403');

    // Create a second unrelated user
    const otherId = crypto.randomUUID();
    await cleanupDb.insert(schema.users).values({ id: otherId, email: 'other@test.com', passwordHash: 'x', role: 'customer' });
    const otherToken = await issueAccessToken(otherId, 'customer', env);

    const res = await dispatch(
      new Request(`${BASE}/logistics/shipments/${shipment.id}`, {
        headers: { Authorization: `Bearer ${otherToken}` },
      }),
      env,
    );

    expect(res.status).toBe(403);
  });
});

describe('PUT /logistics/shipments/:id', () => {
  it('updating status to delivered advances order to delivered', async () => {
    const { orderId } = await setupOrderAndCustomer();
    const { shipment } = await createShipment(orderId, 'TRK-DEL');

    const res = await dispatch(
      new Request(`${BASE}/logistics/shipments/${shipment.id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body:    JSON.stringify({ status: 'delivered' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { data: typeof schema.shipments.$inferSelect };
    expect(body.data.status).toBe('delivered');
    expect(body.data.deliveredAt).toBeTruthy();

    const orderRows = await cleanupDb
      .select({ status: schema.orders.status })
      .from(schema.orders)
      .where(require('drizzle-orm').eq(schema.orders.id, orderId));
    expect(orderRows[0]?.status).toBe('delivered');
  });
});

describe('GET /logistics/tracking/:trackingNumber', () => {
  it('returns public fields for a valid tracking number', async () => {
    const { orderId } = await setupOrderAndCustomer();
    await createShipment(orderId, 'TRK-PUB', 'FedEx');

    const res = await dispatch(
      new Request(`${BASE}/logistics/tracking/TRK-PUB`),
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data.carrier).toBe('FedEx');
    expect(body.data.status).toBeDefined();
    // Must NOT expose orderId or internal id
    expect(body.data.orderId).toBeUndefined();
    expect(body.data.id).toBeUndefined();
  });

  it('returns 404 for a nonexistent tracking number', async () => {
    const res = await dispatch(
      new Request(`${BASE}/logistics/tracking/NONEXISTENT-999`),
      env,
    );

    expect(res.status).toBe(404);
  });
});
