import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from '../../src/db/schema.js';
import type { AppEnv } from '../../src/types.js';
import { handleSalesReport, handleInventoryReport, handleCustomersReport } from './reports.js';
import { handleDashboard } from './dashboard.js';

let env: AppEnv;
let cleanupDb: any;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);
  const client = createClient({ url: 'file:local.sqlite' });
  cleanupDb = drizzle(client, {});
  await migrate(cleanupDb, { migrationsFolder: 'src/db/migrations' });
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

afterEach(async () => {
  await cleanupDb.delete(schema.shipments);
  await cleanupDb.delete(schema.orderLines);
  await cleanupDb.delete(schema.orders);
  await cleanupDb.delete(schema.productVariants);
  await cleanupDb.delete(schema.products);
  await cleanupDb.delete(schema.addresses);
  await cleanupDb.delete(schema.customers);
  await cleanupDb.delete(schema.users);
});

// Helper: create a minimal customer + order
async function insertOrder(total: number, status = 'delivered') {
  const userId = crypto.randomUUID();
  const customerId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  await cleanupDb.insert(schema.users).values({ id: userId, email: `${userId}@t.com`, passwordHash: 'x', role: 'customer' });
  await cleanupDb.insert(schema.customers).values({ id: customerId, userId, firstName: 'T', lastName: 'U' });
  await cleanupDb.insert(schema.orders).values({ id: orderId, customerId, status, subtotal: total, total });
  return orderId;
}

describe('GET /admin/reports/sales', () => {
  it('returns 400 without from/to params', async () => {
    const res = await handleSalesReport(new Request('http://admin/admin/reports/sales'), env);
    expect(res.status).toBe(400);
  });

  it('returns sales totals for date range', async () => {
    await insertOrder(100);
    const today = new Date().toISOString().slice(0, 10);
    const res = await handleSalesReport(
      new Request(`http://admin/admin/reports/sales?from=${today}&to=${today}`), env
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.totalOrders).toBeGreaterThanOrEqual(1);
    expect(body.data.totalRevenue).toBeGreaterThan(0);
    expect(body.data.daily).toBeArray();
  });

  it('excludes cancelled orders from revenue', async () => {
    await insertOrder(500, 'cancelled');
    const today = new Date().toISOString().slice(0, 10);
    const res = await handleSalesReport(
      new Request(`http://admin/admin/reports/sales?from=${today}&to=${today}`), env
    );
    const body = await res.json() as any;
    expect(body.data.totalRevenue).toBe(0);
  });
});

describe('GET /admin/reports/inventory', () => {
  it('returns all products with variants', async () => {
    await cleanupDb.insert(schema.products).values({
      id: crypto.randomUUID(), name: 'Widget', slug: 'widget', price: 9.99, status: 'active',
    });
    const res = await handleInventoryReport(new Request('http://admin/admin/reports/inventory'), env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toBeArray();
    expect(body.data[0].variants).toBeArray();
  });
});

describe('GET /admin/reports/customers', () => {
  it('returns active, inactive counts and newPerDay', async () => {
    const userId = crypto.randomUUID();
    await cleanupDb.insert(schema.users).values({ id: userId, email: 'a@b.com', passwordHash: 'x', role: 'customer' });
    const res = await handleCustomersReport(new Request('http://admin/admin/reports/customers'), env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.totalActive).toBeGreaterThanOrEqual(1);
    expect(body.data.totalInactive).toBeGreaterThanOrEqual(0);
    expect(body.data.newPerDay).toBeArray();
  });
});

describe('GET /admin/dashboard', () => {
  it('returns summary fields', async () => {
    const res = await handleDashboard(new Request('http://admin/admin/dashboard'), env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(typeof body.data.ordersToday).toBe('number');
    expect(typeof body.data.revenueToday).toBe('number');
    expect(typeof body.data.newCustomersToday).toBe('number');
    expect(body.data.lowStockProducts).toBeArray();
  });
});
