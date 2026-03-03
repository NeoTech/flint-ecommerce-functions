/**
 * LOPC-19: Admin data-health endpoint tests.
 *
 * Routes tested through dispatch() so full middleware chain runs.
 * Uses local SQLite (local.sqlite) with migrations applied in beforeAll.
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
    STRIPE_SECRET_KEY: 'sk_test_mock',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_mock',
  };
});

afterEach(async () => {
  // FK-safe cleanup order
  await cleanupDb.delete(schema.stripeOrderImportStaging);
  await cleanupDb.delete(schema.processedWebhookEvents);
  await cleanupDb.delete(schema.orderLines);
  await cleanupDb.delete(schema.shipments);
  await cleanupDb.delete(schema.orders);
  await cleanupDb.delete(schema.addresses);
  await cleanupDb.delete(schema.customers);
  await cleanupDb.delete(schema.refreshTokens);
  await cleanupDb.delete(schema.users);
  await cleanupDb.delete(schema.products);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function adminHeaders(): Promise<Record<string, string>> {
  const userId = crypto.randomUUID();
  await cleanupDb.insert(schema.users).values({ id: userId, email: `admin-${userId}@test.local`, passwordHash: 'x', role: 'admin' });
  const token = await issueAccessToken(userId, 'admin', env);
  return { Authorization: `Bearer ${token}` };
}

async function customerHeaders(): Promise<Record<string, string>> {
  const userId = crypto.randomUUID();
  await cleanupDb.insert(schema.users).values({ id: userId, email: `cust-${userId}@test.local`, passwordHash: 'x', role: 'customer' });
  const token = await issueAccessToken(userId, 'customer', env);
  return { Authorization: `Bearer ${token}` };
}

function get(path: string, headers?: Record<string, string>): Promise<Response> {
  return dispatch(new Request(`${BASE}${path}`, { method: 'GET', headers }), env);
}

function post(path: string, headers?: Record<string, string>): Promise<Response> {
  return dispatch(new Request(`${BASE}${path}`, { method: 'POST', headers }), env);
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedCustomerWithUser(email = 'seed@test.local') {
  const userId = crypto.randomUUID();
  const customerId = crypto.randomUUID();
  await cleanupDb.insert(schema.users).values({ id: userId, email, passwordHash: 'x', role: 'customer' });
  await cleanupDb.insert(schema.customers).values({ id: customerId, userId, firstName: 'Seed', lastName: 'User' });
  return { userId, customerId };
}

async function seedAddress(customerId: string, overrides: Partial<schema.NewAddress> = {}) {
  const id = crypto.randomUUID();
  await cleanupDb.insert(schema.addresses).values({
    id,
    customerId,
    type: 'shipping',
    street: '1 Test St',
    city: 'Testville',
    postalCode: '00001',
    country: 'SE',
    ...overrides,
  });
  return id;
}

async function seedOrder(customerId: string, shippingAddressId: string, overrides: Partial<schema.NewOrder> = {}) {
  const id = crypto.randomUUID();
  await cleanupDb.insert(schema.orders).values({
    id,
    customerId,
    subtotal: 10,
    total: 10,
    source: 'stripe',
    shippingAddressId,
    billingAddressId: shippingAddressId,
    stripePaymentIntentId: `pi_test_${id}`,
    ...overrides,
  });
  return id;
}

async function seedOrderLine(orderId: string, productId: string) {
  const id = crypto.randomUUID();
  await cleanupDb.insert(schema.orderLines).values({ id, orderId, productId, quantity: 1, unitPrice: 10, lineTotal: 10 });
  return id;
}

async function seedProduct() {
  const id = crypto.randomUUID();
  await cleanupDb.insert(schema.products).values({ id, name: 'Test Product', slug: `slug-${id}`, price: 10, stock: 5, status: 'active' });
  return id;
}

// ---------------------------------------------------------------------------
// GET /admin/data-health
// ---------------------------------------------------------------------------

describe('GET /admin/data-health', () => {
  it('returns 403 for non-admin', async () => {
    const headers = await customerHeaders();
    const res = await get('/admin/data-health', headers);
    expect(res.status).toBe(403);
  });

  it('returns 200 with all zero orphan counts on clean DB', async () => {
    const headers = await adminHeaders();
    const res = await get('/admin/data-health', headers);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data).toBeDefined();
    const d = body.data as Record<string, unknown>;
    const orphans = d.orphans as Record<string, unknown>;
    expect(orphans.orderLinesNoOrder).toBe(0);
    expect(orphans.shipmentsNoOrder).toBe(0);
    expect(orphans.ordersWithMissingAddress).toBe(0);
    const addrOrphans = orphans.addressesUnreferencedByOrders as { count: number };
    expect(addrOrphans.count).toBe(0);
    const dups = d.duplicates as { addressGroups: { count: number } };
    expect(dups.addressGroups.count).toBe(0);
    const webhooks = d.webhooks as { stuckOrders: { count: number } };
    expect(webhooks.stuckOrders.count).toBe(0);
  });

  it('detects orphan address (unreferenced by any order)', async () => {
    const { customerId } = await seedCustomerWithUser('orphan-addr@test.local');
    await seedAddress(customerId); // no order references this

    const headers = await adminHeaders();
    const res = await get('/admin/data-health', headers);
    expect(res.status).toBe(200);
    const body = await json(res);
    const orphans = (body.data as Record<string, unknown>).orphans as Record<string, unknown>;
    const addrOrphans = orphans.addressesUnreferencedByOrders as { count: number };
    expect(addrOrphans.count).toBeGreaterThanOrEqual(1);
  });

  it('detects duplicate address group', async () => {
    const { customerId } = await seedCustomerWithUser('dup-addr@test.local');
    // Two identical addresses on same customer
    await seedAddress(customerId, { street: 'Dup St', city: 'DupCity', postalCode: '99999', country: 'SE' });
    await seedAddress(customerId, { street: 'Dup St', city: 'DupCity', postalCode: '99999', country: 'SE' });

    const headers = await adminHeaders();
    const res = await get('/admin/data-health', headers);
    const body = await json(res);
    const dups = ((body.data as Record<string, unknown>).duplicates as { addressGroups: { count: number } });
    expect(dups.addressGroups.count).toBeGreaterThanOrEqual(1);
  });

  it('detects stuck webhook order (stripe order without processed_webhook_events row)', async () => {
    const { customerId } = await seedCustomerWithUser('stuck@test.local');
    const addrId = await seedAddress(customerId);
    await seedOrder(customerId, addrId, { source: 'stripe', stripePaymentIntentId: 'pi_stuck_test' });
    // No entry in processed_webhook_events

    const headers = await adminHeaders();
    const res = await get('/admin/data-health', headers);
    const body = await json(res);
    const webhooks = ((body.data as Record<string, unknown>).webhooks as { stuckOrders: { count: number } });
    expect(webhooks.stuckOrders.count).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/data-health — missing/unknown action
// ---------------------------------------------------------------------------

describe('POST /admin/data-health — action validation', () => {
  it('returns 400 when action query param is missing', async () => {
    const headers = await adminHeaders();
    const res = await post('/admin/data-health', headers);
    expect(res.status).toBe(400);
  });

  it('returns 400 for unknown action', async () => {
    const headers = await adminHeaders();
    const res = await post('/admin/data-health?action=destroy-everything', headers);
    expect(res.status).toBe(400);
  });

  it('returns 403 for non-admin', async () => {
    const headers = await customerHeaders();
    const res = await post('/admin/data-health?action=purge-orphans', headers);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST ?action=purge-orphans
// ---------------------------------------------------------------------------

describe('POST /admin/data-health?action=purge-orphans', () => {
  it('deletes orphan addresses and returns deleted counts', async () => {
    const { customerId } = await seedCustomerWithUser('purge@test.local');
    await seedAddress(customerId); // orphan — no order references it

    const headers = await adminHeaders();
    const res = await post('/admin/data-health?action=purge-orphans', headers);
    expect(res.status).toBe(200);
    const body = await json(res);
    const deleted = (body.data as Record<string, unknown>).deleted as Record<string, number>;
    expect(deleted.addresses).toBeGreaterThanOrEqual(1);

    // No orphan addresses remain
    const remaining = await cleanupDb.select().from(schema.addresses);
    expect(remaining.length).toBe(0);
  });

  it('does not delete addresses that are referenced by orders', async () => {
    const { customerId } = await seedCustomerWithUser('keep-addr@test.local');
    const addrId = await seedAddress(customerId);
    await seedOrder(customerId, addrId); // references the address

    const headers = await adminHeaders();
    await post('/admin/data-health?action=purge-orphans', headers);

    const remaining = await cleanupDb.select().from(schema.addresses);
    expect(remaining.some(a => a.id === addrId)).toBe(true);
  });

  it('reports zero deleted when DB is clean', async () => {
    const headers = await adminHeaders();
    const res = await post('/admin/data-health?action=purge-orphans', headers);
    expect(res.status).toBe(200);
    const body = await json(res);
    const deleted = (body.data as Record<string, unknown>).deleted as Record<string, number>;
    expect(deleted.addresses).toBe(0);
    expect(deleted.orderLines).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST ?action=dedupe-addresses
// ---------------------------------------------------------------------------

describe('POST /admin/data-health?action=dedupe-addresses', () => {
  it('removes exact duplicate addresses, keeping oldest (lowest UUID)', async () => {
    const { customerId } = await seedCustomerWithUser('dedup@test.local');
    const id1 = await seedAddress(customerId, { street: 'Dup St', city: 'DupCity', postalCode: '11111', country: 'SE' });
    const id2 = await seedAddress(customerId, { street: 'Dup St', city: 'DupCity', postalCode: '11111', country: 'SE' });

    const headers = await adminHeaders();
    const res = await post('/admin/data-health?action=dedupe-addresses', headers);
    expect(res.status).toBe(200);
    const body = await json(res);
    const deleted = (body.data as Record<string, unknown>).deleted as { addresses: number };
    expect(deleted.addresses).toBe(1);

    const remaining = await cleanupDb.select().from(schema.addresses);
    expect(remaining.length).toBe(1);
    // The other one survives
    const survivingId = remaining[0].id;
    expect([id1, id2]).toContain(survivingId);
  });

  it('preserves order-linked duplicate over non-linked one', async () => {
    const { customerId } = await seedCustomerWithUser('dedup-linked@test.local');
    // Two identical addresses — only second one will be referenced by an order
    await seedAddress(customerId, { street: 'Linked St', city: 'LinkedCity', postalCode: '22222', country: 'SE' });
    const linkedId = await seedAddress(customerId, { street: 'Linked St', city: 'LinkedCity', postalCode: '22222', country: 'SE' });
    await seedOrder(customerId, linkedId);

    const headers = await adminHeaders();
    await post('/admin/data-health?action=dedupe-addresses', headers);

    const remaining = await cleanupDb.select().from(schema.addresses);
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe(linkedId);
  });

  it('returns zero deleted when no duplicates exist', async () => {
    const headers = await adminHeaders();
    const res = await post('/admin/data-health?action=dedupe-addresses', headers);
    expect(res.status).toBe(200);
    const body = await json(res);
    const deleted = (body.data as Record<string, unknown>).deleted as { addresses: number };
    expect(deleted.addresses).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST ?action=mark-webhook-processed
// ---------------------------------------------------------------------------

describe('POST /admin/data-health?action=mark-webhook-processed', () => {
  it('returns 400 when eventId is missing', async () => {
    const headers = await adminHeaders();
    const res = await post('/admin/data-health?action=mark-webhook-processed', headers);
    expect(res.status).toBe(400);
  });

  it('inserts eventId and returns inserted: true', async () => {
    const headers = await adminHeaders();
    const res = await post('/admin/data-health?action=mark-webhook-processed&eventId=evt_test_001', headers);
    expect(res.status).toBe(200);
    const body = await json(res);
    const d = body.data as Record<string, unknown>;
    expect(d.inserted).toBe(true);
    expect(d.alreadyPresent).toBe(false);

    const rows = await cleanupDb.select().from(schema.processedWebhookEvents);
    expect(rows.some(r => r.stripeEventId === 'evt_test_001')).toBe(true);
  });

  it('returns alreadyPresent: true on second call with same eventId', async () => {
    const headers = await adminHeaders();
    await post('/admin/data-health?action=mark-webhook-processed&eventId=evt_test_dup', headers);
    const res2 = await post('/admin/data-health?action=mark-webhook-processed&eventId=evt_test_dup', headers);
    expect(res2.status).toBe(200);
    const body = await json(res2);
    const d = body.data as Record<string, unknown>;
    expect(d.alreadyPresent).toBe(true);
    expect(d.inserted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST ?action=rollback-order
// ---------------------------------------------------------------------------

describe('POST /admin/data-health?action=rollback-order', () => {
  it('returns 400 when paymentIntentId is missing', async () => {
    const headers = await adminHeaders();
    const res = await post('/admin/data-health?action=rollback-order', headers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when paymentIntentId does not match any order', async () => {
    const headers = await adminHeaders();
    const res = await post('/admin/data-health?action=rollback-order&paymentIntentId=pi_nonexistant', headers);
    expect(res.status).toBe(400);
  });

  it('deletes order and its lines, returns confirmation', async () => {
    const { customerId } = await seedCustomerWithUser('rollback@test.local');
    const addrId = await seedAddress(customerId);
    const productId = await seedProduct();
    const orderId = await seedOrder(customerId, addrId, { stripePaymentIntentId: 'pi_rollback_test' });
    await seedOrderLine(orderId, productId);

    const headers = await adminHeaders();
    const res = await post('/admin/data-health?action=rollback-order&paymentIntentId=pi_rollback_test', headers);
    expect(res.status).toBe(200);
    const body = await json(res);
    const d = body.data as Record<string, unknown>;
    expect(d.orderId).toBe(orderId);
    expect((d.deleted as Record<string, unknown>).order).toBe(true);

    const remainingOrders = await cleanupDb.select().from(schema.orders);
    expect(remainingOrders.length).toBe(0);
    const remainingLines = await cleanupDb.select().from(schema.orderLines);
    expect(remainingLines.length).toBe(0);
  });

  it('removes processed_webhook_events row when present', async () => {
    const { customerId } = await seedCustomerWithUser('rollback-evt@test.local');
    const addrId = await seedAddress(customerId);
    const orderId = await seedOrder(customerId, addrId, { stripePaymentIntentId: 'pi_rollback_evt_test' });
    // Simulate a processed event containing the payment intent in its ID
    await cleanupDb.insert(schema.processedWebhookEvents).values({ stripeEventId: 'evt_contains_pi_rollback_evt_test' });

    const headers = await adminHeaders();
    const res = await post('/admin/data-health?action=rollback-order&paymentIntentId=pi_rollback_evt_test', headers);
    expect(res.status).toBe(200);

    const remaining = await cleanupDb.select().from(schema.processedWebhookEvents);
    expect(remaining.length).toBe(0);

    const remainingOrders = await cleanupDb.select().from(schema.orders);
    expect(remainingOrders.length).toBe(0);
    void orderId;
  });

  it('address and customer are preserved after order rollback', async () => {
    const { customerId } = await seedCustomerWithUser('rollback-preserve@test.local');
    const addrId = await seedAddress(customerId);
    await seedOrder(customerId, addrId, { stripePaymentIntentId: 'pi_rollback_preserve' });

    const headers = await adminHeaders();
    await post('/admin/data-health?action=rollback-order&paymentIntentId=pi_rollback_preserve', headers);

    const remainingAddresses = await cleanupDb.select().from(schema.addresses);
    expect(remainingAddresses.some(a => a.id === addrId)).toBe(true);
    const remainingCustomers = await cleanupDb.select().from(schema.customers);
    expect(remainingCustomers.some(c => c.id === customerId)).toBe(true);
  });
});
