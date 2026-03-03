/**
 * Customers API integration tests.
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
  await cleanupDb.delete(schema.addresses);
  await cleanupDb.delete(schema.orderLines);
  await cleanupDb.delete(schema.orders);
  await cleanupDb.delete(schema.customers);
  await cleanupDb.delete(schema.refreshTokens);
  await cleanupDb.delete(schema.users);
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

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

/**
 * Register a new user and return customer + user details.
 */
async function createUserAndCustomer(
  email: string,
  firstName = 'Test',
  lastName = 'User',
): Promise<{ customerId: string; userId: string }> {
  await post('/auth/register', { email, password: 'password123', firstName, lastName });
  const allUsers = await cleanupDb.select().from(schema.users);
  const allCustomers = await cleanupDb.select().from(schema.customers);
  const user = allUsers.find((u) => u.email === email)!;
  const customer = allCustomers.find((c) => c.userId === user.id)!;
  return { customerId: customer.id, userId: user.id };
}

async function bearerHeaders(userId: string, role: 'customer' | 'admin'): Promise<Record<string, string>> {
  const token = await issueAccessToken(userId, role, env);
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// ---------------------------------------------------------------------------
// GET /customers
// ---------------------------------------------------------------------------

describe('GET /customers', () => {
  it('returns 401 without a token', async () => {
    const res = await get('/customers');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin customer token', async () => {
    const { userId } = await createUserAndCustomer('cust1@test.com');
    const headers = await bearerHeaders(userId, 'customer');
    const res = await get('/customers', headers);
    expect(res.status).toBe(403);
  });

  it('returns paginated list for admin', async () => {
    await createUserAndCustomer('a@test.com', 'Alice', 'Smith');
    await createUserAndCustomer('b@test.com', 'Bob', 'Jones');

    const { userId } = await createUserAndCustomer('admin@test.com', 'Admin', 'User');
    const headers = await bearerHeaders(userId, 'admin');

    const res = await get('/customers', headers);
    expect(res.status).toBe(200);
    const body = await json<{ data: unknown[]; meta: { total: number } }>(res);
    expect(body.data).toBeArray();
    expect(body.meta.total).toBeGreaterThanOrEqual(3);
  });

  it('filters by search term', async () => {
    await createUserAndCustomer('alice@test.com', 'Alice', 'Smith');
    await createUserAndCustomer('bob@test.com', 'Bob', 'Jones');

    const { userId } = await createUserAndCustomer('admin@test.com', 'Admin', 'User');
    const headers = await bearerHeaders(userId, 'admin');

    const res = await get('/customers?search=alice', headers);
    expect(res.status).toBe(200);
    const body = await json<{ data: Array<{ email: string }> }>(res);
    expect(body.data.some((c) => c.email === 'alice@test.com')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /customers/:id
// ---------------------------------------------------------------------------

describe('GET /customers/:id', () => {
  it('returns 401 without a token', async () => {
    const { customerId } = await createUserAndCustomer('x@test.com');
    const res = await get(`/customers/${customerId}`);
    expect(res.status).toBe(401);
  });

  it('allows customer to access own record', async () => {
    const { customerId, userId } = await createUserAndCustomer('self@test.com', 'Self', 'User');
    const headers = await bearerHeaders(userId, 'customer');
    const res = await get(`/customers/${customerId}`, headers);
    expect(res.status).toBe(200);
    const body = await json<{ data: { id: string; email: string } }>(res);
    expect(body.data.id).toBe(customerId);
    expect(body.data.email).toBe('self@test.com');
  });

  it('returns 403 when customer tries to access another customer record', async () => {
    const { customerId: targetId } = await createUserAndCustomer('target@test.com', 'Target', 'User');
    const { userId: otherId } = await createUserAndCustomer('other@test.com', 'Other', 'User');
    const headers = await bearerHeaders(otherId, 'customer');
    const res = await get(`/customers/${targetId}`, headers);
    expect(res.status).toBe(403);
  });

  it('allows admin to access any customer record', async () => {
    const { customerId } = await createUserAndCustomer('someone@test.com', 'Someone', 'User');
    const { userId: adminId } = await createUserAndCustomer('admin@test.com', 'Admin', 'User');
    const headers = await bearerHeaders(adminId, 'admin');
    const res = await get(`/customers/${customerId}`, headers);
    expect(res.status).toBe(200);
  });

  it('returns 404 for nonexistent customer', async () => {
    const { userId } = await createUserAndCustomer('admin@test.com', 'Admin', 'User');
    const headers = await bearerHeaders(userId, 'admin');
    const res = await get('/customers/nonexistent', headers);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT /customers/:id
// ---------------------------------------------------------------------------

describe('PUT /customers/:id', () => {
  it('allows customer to update own name and phone', async () => {
    const { customerId, userId } = await createUserAndCustomer('edit@test.com', 'Edit', 'Me');
    const headers = await bearerHeaders(userId, 'customer');
    const res = await put(`/customers/${customerId}`, { firstName: 'Updated', phone: '555-1234' }, headers);
    expect(res.status).toBe(200);
    const body = await json<{ data: { firstName: string; phone: string } }>(res);
    expect(body.data.firstName).toBe('Updated');
    expect(body.data.phone).toBe('555-1234');
  });

  it('returns 403 when non-admin tries to update role', async () => {
    const { customerId, userId } = await createUserAndCustomer('norole@test.com', 'No', 'Role');
    const headers = await bearerHeaders(userId, 'customer');
    const res = await put(`/customers/${customerId}`, { role: 'admin' }, headers);
    expect(res.status).toBe(403);
  });

  it('allows admin to update role', async () => {
    const { customerId } = await createUserAndCustomer('promote@test.com', 'Promote', 'Me');
    const { userId: adminId } = await createUserAndCustomer('admin@test.com', 'Admin', 'User');
    const headers = await bearerHeaders(adminId, 'admin');
    const res = await put(`/customers/${customerId}`, { role: 'inactive' }, headers);
    expect(res.status).toBe(200);
    const body = await json<{ data: { role: string } }>(res);
    expect(body.data.role).toBe('inactive');
  });

  it('returns 403 when customer tries to update another customers record', async () => {
    const { customerId: targetId } = await createUserAndCustomer('target2@test.com', 'Target', 'User');
    const { userId: otherId } = await createUserAndCustomer('other2@test.com', 'Other', 'User');
    const headers = await bearerHeaders(otherId, 'customer');
    const res = await put(`/customers/${targetId}`, { firstName: 'Hacked' }, headers);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /customers/:id
// ---------------------------------------------------------------------------

describe('DELETE /customers/:id', () => {
  it('returns 401 without a token', async () => {
    const { customerId } = await createUserAndCustomer('del@test.com');
    const res = await del(`/customers/${customerId}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    const { customerId, userId } = await createUserAndCustomer('nodel@test.com');
    const headers = await bearerHeaders(userId, 'customer');
    const res = await del(`/customers/${customerId}`, headers);
    expect(res.status).toBe(403);
  });

  it('admin can deactivate a customer (sets role to inactive)', async () => {
    const { customerId, userId: targetUserId } = await createUserAndCustomer('deactivate@test.com');
    const { userId: adminId } = await createUserAndCustomer('adminx@test.com', 'Admin', 'X');
    const headers = await bearerHeaders(adminId, 'admin');
    const res = await del(`/customers/${customerId}`, headers);
    expect(res.status).toBe(204);

    // Verify user role changed
    const allUsers = await cleanupDb.select().from(schema.users);
    const user = allUsers.find((u) => u.id === targetUserId)!
    expect(user.role).toBe('inactive');
  });

  it('returns 404 for nonexistent customer', async () => {
    const { userId: adminId } = await createUserAndCustomer('admin2@test.com', 'Admin', '2');
    const headers = await bearerHeaders(adminId, 'admin');
    const res = await del('/customers/nonexistent', headers);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /customers/:id/orders
// ---------------------------------------------------------------------------

describe('GET /customers/:id/orders', () => {
  it('returns 403 when customer tries to view another customers orders', async () => {
    const { customerId: targetId } = await createUserAndCustomer('orderstarget@test.com', 'Target', 'User');
    const { userId: otherId } = await createUserAndCustomer('ordersother@test.com', 'Other', 'User');
    const headers = await bearerHeaders(otherId, 'customer');
    const res = await get(`/customers/${targetId}/orders`, headers);
    expect(res.status).toBe(403);
  });

  it('allows customer to view own orders with lineCount', async () => {
    const { customerId, userId } = await createUserAndCustomer('orders@test.com', 'Orders', 'User');
    const headers = await bearerHeaders(userId, 'customer');

    // Insert an order
    await cleanupDb.insert(schema.orders).values({
      customerId,
      subtotal: 50,
      tax: 5,
      total: 55,
    });

    const res = await get(`/customers/${customerId}/orders`, headers);
    expect(res.status).toBe(200);
    const body = await json<{ data: Array<{ lineCount: number }> }>(res);
    expect(body.data).toBeArray();
    expect(body.data.length).toBe(1);
    expect(body.data[0].lineCount).toBe(0);
  });

  it('allows admin to view any customers orders', async () => {
    const { customerId } = await createUserAndCustomer('ordersadmin@test.com', 'OrdersAdmin', 'User');
    const { userId: adminId } = await createUserAndCustomer('admino@test.com', 'Admin', 'O');
    const headers = await bearerHeaders(adminId, 'admin');
    const res = await get(`/customers/${customerId}/orders`, headers);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /customers/:id/addresses
// ---------------------------------------------------------------------------

describe('GET /customers/:id/addresses', () => {
  it('returns 403 when customer tries to view another customers addresses', async () => {
    const { customerId: targetId } = await createUserAndCustomer('addrstarget@test.com', 'Target', 'User');
    const { userId: otherId } = await createUserAndCustomer('addrsother@test.com', 'Other', 'User');
    const headers = await bearerHeaders(otherId, 'customer');
    const res = await get(`/customers/${targetId}/addresses`, headers);
    expect(res.status).toBe(403);
  });

  it('allows customer to view own addresses', async () => {
    const { customerId, userId } = await createUserAndCustomer('addrs@test.com', 'Addrs', 'User');
    const headers = await bearerHeaders(userId, 'customer');

    await cleanupDb.insert(schema.addresses).values({
      customerId,
      type: 'shipping',
      street: '123 Main St',
      city: 'Anytown',
      postalCode: '12345',
    });

    const res = await get(`/customers/${customerId}/addresses`, headers);
    expect(res.status).toBe(200);
    const body = await json<{ data: Array<{ street: string }> }>(res);
    expect(body.data.length).toBe(1);
    expect(body.data[0].street).toBe('123 Main St');
  });
});

// ---------------------------------------------------------------------------
// POST /customers/:id/addresses
// ---------------------------------------------------------------------------

describe('POST /customers/:id/addresses', () => {
  it('creates a new address', async () => {
    const { customerId, userId } = await createUserAndCustomer('newaddr@test.com', 'New', 'Addr');
    const headers = await bearerHeaders(userId, 'customer');
    const res = await post(
      `/customers/${customerId}/addresses`,
      { type: 'shipping', street: '1 Tree Lane', city: 'Springfield', postalCode: '99999' },
      headers,
    );
    expect(res.status).toBe(201);
    const body = await json<{ data: { street: string; country: string } }>(res);
    expect(body.data.street).toBe('1 Tree Lane');
    expect(body.data.country).toBe('US');
  });

  it('setting isDefault=true unsets previous default of same type', async () => {
    const { customerId, userId } = await createUserAndCustomer('default@test.com', 'Default', 'Addr');
    const headers = await bearerHeaders(userId, 'customer');

    // Create first default address
    const r1 = await post(
      `/customers/${customerId}/addresses`,
      { type: 'shipping', street: 'First St', city: 'City', postalCode: '11111', isDefault: true },
      headers,
    );
    const addr1 = await json<{ data: { id: string } }>(r1);
    const addr1Id = addr1.data.id;

    // Create second default address
    await post(
      `/customers/${customerId}/addresses`,
      { type: 'shipping', street: 'Second St', city: 'City', postalCode: '22222', isDefault: true },
      headers,
    );

    // First address should no longer be default
    const allAddrs = await cleanupDb.select().from(schema.addresses);
    const first = allAddrs.find((a) => a.id === addr1Id)!;
    expect(first.isDefault).toBe(false);
  });

  it('returns 403 when customer tries to create address for another customer', async () => {
    const { customerId: targetId } = await createUserAndCustomer('addrother@test.com', 'Other', 'C');
    const { userId: otherId } = await createUserAndCustomer('addrme@test.com', 'Me', 'C');
    const headers = await bearerHeaders(otherId, 'customer');
    const res = await post(
      `/customers/${targetId}/addresses`,
      { street: 'Hacker St', city: 'Evil', postalCode: '00000' },
      headers,
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /customers/:id/addresses/:addressId
// ---------------------------------------------------------------------------

describe('DELETE /customers/:id/addresses/:addressId', () => {
  it('deletes own address', async () => {
    const { customerId, userId } = await createUserAndCustomer('deladdrx@test.com', 'Del', 'Addr');
    const headers = await bearerHeaders(userId, 'customer');

    const createRes = await post(
      `/customers/${customerId}/addresses`,
      { street: 'To Delete', city: 'City', postalCode: '00000' },
      headers,
    );
    const { data: addr } = await json<{ data: { id: string } }>(createRes);

    const res = await del(`/customers/${customerId}/addresses/${addr.id}`, headers);
    expect(res.status).toBe(204);

    const remaining = await cleanupDb.select().from(schema.addresses);
    expect(remaining.find((a) => a.id === addr.id)).toBeUndefined();
  });

  it('returns 404 for nonexistent address', async () => {
    const { customerId, userId } = await createUserAndCustomer('deladdr404@test.com', 'Del', '404');
    const headers = await bearerHeaders(userId, 'customer');
    const res = await del(`/customers/${customerId}/addresses/nonexistent`, headers);
    expect(res.status).toBe(404);
  });

  it('returns 403 when customer tries to delete another customers address', async () => {
    const { customerId: targetId } = await createUserAndCustomer('delother@test.com', 'Target', 'C');
    const { userId: otherId } = await createUserAndCustomer('delme@test.com', 'Me', 'C');

    // Insert address for target
    const [addr] = await cleanupDb
      .insert(schema.addresses)
      .values({ customerId: targetId, street: 'Target St', city: 'City', postalCode: '00000' })
      .returning();

    const headers = await bearerHeaders(otherId, 'customer');
    const res = await del(`/customers/${targetId}/addresses/${addr.id}`, headers);
    expect(res.status).toBe(403);
  });
});
