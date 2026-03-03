/**
 * LOPC-13: Stripe integration tests.
 *
 * Covers checkout, webhooks, and admin sync routes.
 * The Stripe SDK is mocked so no real API calls are made.
 */
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  mock,
} from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, SignJWT } from 'jose';
import {
  customers,
  orderLines,
  orders,
  processedWebhookEvents,
  products,
  stripeOrderImportStaging,
  users,
} from '../db/schema.js';
import { dispatch } from '../router.js';
import type { AppEnv } from '../types.js';

// ---------------------------------------------------------------------------
// Stripe mock — must be declared before app.ts is imported
// ---------------------------------------------------------------------------

const mockConstructEventAsync = mock(async (_body: unknown, _sig: string, _secret: string) => ({
  id: 'evt_test001',
  type: 'checkout.session.completed',
  data: {
    object: {
      id: 'cs_test001',
      payment_status: 'paid',
      customer: 'cus_test001',
      customer_details: { email: 'buyer@example.com', name: 'Buyer Name' },
      shipping_details: null,
      payment_intent: 'pi_test001',
      amount_total: 2999,
    },
  },
}));

const mockCheckoutSessionsList = mock(async () => ({ data: [], has_more: false }));
const mockListLineItems = mock(async () => ({ data: [], has_more: false }));
const mockChargesList = mock(async () => ({ data: [], has_more: false }));

const mockCustomersCreate = mock(async () => ({ id: 'cus_test001' }));
const mockCustomersList = mock(async () => ({ data: [] }));
const mockProductsCreate = mock(async (data: { name: string }) => ({
  id: `sp_${data.name.replace(/\s/g, '_')}`,
  name: data.name,
}));
const mockProductsList = mock(async () => ({ data: [], has_more: false }));
const mockPricesCreate = mock(async () => ({ id: 'price_test001' }));
const mockProductsUpdate = mock(async () => ({}));
const mockPricesUpdate = mock(async () => ({}));
const mockProductsRetrieve = mock(async () => ({}));

const mockStripeInstance = {
  webhooks: {
    constructEventAsync: mockConstructEventAsync,
  },
  charges: {
    list: mockChargesList,
  },
  checkout: {
    sessions: {
      list: mockCheckoutSessionsList,
      listLineItems: mockListLineItems,
    },
  },
  customers: {
    create: mockCustomersCreate,
    list: mockCustomersList,
  },
  products: {
    create: mockProductsCreate,
    list: mockProductsList,
    update: mockProductsUpdate,
    retrieve: mockProductsRetrieve,
  },
  prices: {
    create: mockPricesCreate,
    update: mockPricesUpdate,
  },
};

// Override getStripe before any app module is imported.
mock.module('../lib/stripe.js', () => ({
  getStripe: () => mockStripeInstance,
}));

// Import app after mocking Stripe so routes are registered with the mock in place.
import '../app.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const BASE = 'https://test.local';

let env: AppEnv;
let privateKeyPem: string;
let cleanupDb: ReturnType<typeof drizzle>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);

  const client = createClient({ url: 'file:local.sqlite' });
  cleanupDb = drizzle(client, {});
  await migrate(cleanupDb, { migrationsFolder: './src/db/migrations' });

  env = {
    ENVIRONMENT: 'development',
    DB_SRC: 'local',
    TURSO_DB_URL: '',
    TURSO_AUTH_TOKEN: '',
    JWT_PRIVATE_KEY: privateKeyPem,
    JWT_PUBLIC_KEY: publicKeyPem,
    ALLOWED_ORIGINS: '*',
    STRIPE_SECRET_KEY: 'sk_test_mock',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_mock',
  };
});

afterEach(async () => {
  // Clean in FK-safe order.
  await cleanupDb.delete(stripeOrderImportStaging);
  await cleanupDb.delete(processedWebhookEvents);
  await cleanupDb.delete(orderLines);
  await cleanupDb.delete(orders);
  await cleanupDb.delete(products);
  await cleanupDb.delete(customers);
  await cleanupDb.delete(users);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function authHeader(userId: string, role: 'customer' | 'admin') {
  const key = await importPKCS8(privateKeyPem, 'RS256');
  const token = await new SignJWT({ userId, role })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key);
  return { Authorization: `Bearer ${token}` };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return dispatch(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function seedUser(
  opts: { role?: 'customer' | 'admin'; stripeCustomerId?: string } = {},
) {
  const userId = crypto.randomUUID();
  const customerId = crypto.randomUUID();
  await cleanupDb.insert(users).values({
    id: userId,
    email: `u_${userId}@example.com`,
    passwordHash: 'hash',
    role: opts.role ?? 'customer',
    stripeCustomerId: opts.stripeCustomerId ?? null,
  });
  if (opts.role !== 'admin') {
    await cleanupDb.insert(customers).values({
      id: customerId,
      userId,
      firstName: 'Test',
      lastName: 'User',
    });
  }
  return { userId, customerId };
}

async function seedProduct(opts: { stockQty?: number; stripePriceId?: string } = {}) {
  const productId = crypto.randomUUID();
  await cleanupDb.insert(products).values({
    id: productId,
    name: 'Widget',
    slug: `widget-${productId}`,
    price: 29.99,
    stock: opts.stockQty ?? 10,
    status: 'active',
    stripeProductId: 'sp_widget',
    stripePriceId: opts.stripePriceId ?? 'price_test001',
  });
  return productId;
}

// ---------------------------------------------------------------------------
// POST /webhooks/stripe
// ---------------------------------------------------------------------------

describe('POST /webhooks/stripe', () => {
  it('returns 400 when stripe-signature header is missing', async () => {
    const res = await dispatch(
      new Request(`${BASE}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'test' }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toInclude('stripe-signature');
  });

  it('returns 400 when signature verification fails', async () => {
    mockConstructEventAsync.mockImplementationOnce(async () => {
      throw new Error('Invalid signature');
    });

    const res = await dispatch(
      new Request(`${BASE}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 'bad' },
        body: '{}',
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toInclude('verification failed');
  });

  it('returns 200 for unhandled event type', async () => {
    mockConstructEventAsync.mockImplementationOnce(async () => ({
      id: 'evt_unhandled',
      type: 'customer.created',
      data: { object: {} },
    }));

    const res = await dispatch(
      new Request(`${BASE}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig' },
        body: '{}',
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { received: boolean } };
    expect(body.data.received).toBe(true);
  });

  it('fulfills order on checkout.session.completed and marks event processed', async () => {
    const productId = await seedProduct();

    // Seed the Stripe product/price mapping so fulfillment can find the product.
    await cleanupDb.update(products)
      .set({ stripeProductId: 'sp_widget_test', stripePriceId: 'price_test_001' })
      .where(eq(products.id, productId));

    // Configure listLineItems to return line items pointing to our product.
    mockListLineItems.mockImplementationOnce(async () => ({
      data: [
        {
          amount_total: 2999,
          quantity: 1,
          price: {
            id: 'price_test_001',
            product: 'sp_widget_test',
          },
        },
      ],
      has_more: false,
    }));

    mockConstructEventAsync.mockImplementationOnce(async () => ({
      id: 'evt_fulfill001',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_fulfill001',
          payment_status: 'paid',
          customer: null,
          customer_details: { email: 'webhook-buyer@example.com', name: 'Hook Buyer' },
          shipping_details: null,
          payment_intent: 'pi_webhook001',
          amount_total: 2999,
        },
      },
    }));

    const res = await dispatch(
      new Request(`${BASE}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig' },
        body: '{}',
      }),
      env,
    );

    expect(res.status).toBe(200);

    // Verify order was created.
    const createdOrders = await cleanupDb.select().from(orders).where(
      eq(orders.stripeSessionId, 'cs_fulfill001'),
    );
    expect(createdOrders.length).toBe(1);
    expect(createdOrders[0].source).toBe('stripe');

    // Verify idempotency event was recorded.
    const processed = await cleanupDb.select().from(processedWebhookEvents).where(
      eq(processedWebhookEvents.stripeEventId, 'evt_fulfill001'),
    );
    expect(processed.length).toBe(1);
  });

  it('is idempotent: does not create duplicate orders on retry', async () => {
    // Pre-populate the processed events table.
    await cleanupDb.insert(processedWebhookEvents).values({
      stripeEventId: 'evt_duplicate',
    });

    mockConstructEventAsync.mockImplementationOnce(async () => ({
      id: 'evt_duplicate',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_duplicate',
          payment_status: 'paid',
          customer: null,
          customer_details: { email: 'dup@example.com' },
          shipping_details: null,
          payment_intent: 'pi_dup',
          amount_total: 1000,
        },
      },
    }));

    const res = await dispatch(
      new Request(`${BASE}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig' },
        body: '{}',
      }),
      env,
    );

    expect(res.status).toBe(200);

    // No new orders should be created.
    const ordersForSession = await cleanupDb.select().from(orders).where(
      eq(orders.stripeSessionId, 'cs_duplicate'),
    );
    expect(ordersForSession.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/sync/stripe
// ---------------------------------------------------------------------------

describe('POST /admin/sync/stripe', () => {
  it('returns 401 for unauthenticated requests', async () => {
    const res = await post('/admin/sync/stripe', {});
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    const { userId } = await seedUser();
    const headers = await authHeader(userId, 'customer');
    const res = await post('/admin/sync/stripe', {}, headers);
    expect(res.status).toBe(403);
  });

  it('syncs products and customers as admin', async () => {
    const { userId } = await seedUser({ role: 'admin' });
    const productId = await seedProduct({ stripePriceId: undefined });
    // Clear Stripe IDs to simulate unsynced state.
    await cleanupDb.update(products)
      .set({ stripeProductId: null, stripePriceId: null })
      .where(eq(products.id, productId));

    const headers = await authHeader(userId, 'admin');
    const res = await post('/admin/sync/stripe', {}, headers);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        products: { synced: number; created: number; upToDate: number; imported: number };
        customers: { synced: number; created: number; upToDate: number; imported: number };
        orders: { staged: number; finalized: number; skipped: number; failed: number };
      };
    };

    // One product should have been created in Stripe.
    expect(body.data.products.created).toBeGreaterThanOrEqual(1);
  });

  it('runs catalog phase and imports missing Stripe customers', async () => {
    mockProductsList.mockImplementationOnce(async () => ({ data: [], has_more: false }));
    mockCustomersList.mockImplementationOnce(async () => ({
      data: [
        {
          id: 'cus_catalog_001',
          email: 'catalog-customer@example.com',
          name: 'Catalog Customer',
        },
      ],
      has_more: false,
    }));

    const { userId: adminId } = await seedUser({ role: 'admin' });
    const headers = await authHeader(adminId, 'admin');
    const res = await post('/admin/sync/stripe?phase=catalog', {}, headers);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        phase: string;
        customers: { imported: number };
        orders: { staged: number; finalized: number };
      };
    };
    expect(body.data.phase).toBe('catalog');
    expect(body.data.customers.imported).toBeGreaterThanOrEqual(1);
    expect(body.data.orders.staged).toBe(0);
    expect(body.data.orders.finalized).toBe(0);

    const importedUsers = await cleanupDb.select().from(users).where(eq(users.email, 'catalog-customer@example.com'));
    expect(importedUsers.length).toBe(1);
    const importedCustomers = await cleanupDb.select().from(customers).where(eq(customers.userId, importedUsers[0].id));
    expect(importedCustomers.length).toBe(1);
  });

    it('imports an order from a Stripe charge', async () => {
      const stripeCustomerId = 'cus_charge_test';
      const { userId } = await seedUser({ role: 'customer', stripeCustomerId });
      const productId = await seedProduct({ stripePriceId: 'price_charge_001' });
      await cleanupDb.update(products)
        .set({ stripeProductId: 'sp_charge_widget' })
        .where(eq(products.id, productId));

      mockChargesList.mockImplementationOnce(async () => ({
        data: [
          {
            id: 'ch_test001',
            status: 'succeeded',
            refunded: false,
            amount: 2999,
            amount_refunded: 0,
            payment_intent: 'pi_charge_test001',
            customer: stripeCustomerId,
          },
        ],
        has_more: false,
      }));

        mockCheckoutSessionsList.mockImplementationOnce(async () => ({
          data: [
            {
              id: 'cs_charge_test001',
              status: 'complete',
              payment_status: 'paid',
              customer: stripeCustomerId,
              customer_details: { email: 'buyer@example.com', name: 'Charge Buyer' },
              shipping_details: null,
              payment_intent: 'pi_charge_test001',
              amount_total: 2999,
            },
          ],
          has_more: false,
        }));

      mockListLineItems.mockImplementationOnce(async () => ({
        data: [
          {
            amount_total: 2999,
            quantity: 1,
            price: {
              id: 'price_charge_001',
              product: 'sp_charge_widget',
            },
          },
        ],
        has_more: false,
      }));

      const { userId: adminId } = await seedUser({ role: 'admin' });
      const headers = await authHeader(adminId, 'admin');
      const res = await post('/admin/sync/stripe', {}, headers);

      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: { orders: { staged: number; finalized: number; skipped: number; failed: number } };
      };
      expect(body.data.orders.staged).toBe(1);
      expect(body.data.orders.finalized).toBe(1);

      // Verify order was written to DB with correct payment intent and source.
      const createdOrders = await cleanupDb
        .select()
        .from(orders)
        .where(eq(orders.stripePaymentIntentId, 'pi_charge_test001'));
      expect(createdOrders.length).toBe(1);
      expect(createdOrders[0].source).toBe('stripe');
      expect(createdOrders[0].status).toBe('confirmed');
      expect(createdOrders[0].stripeSessionId).toBeNull();
      expect(createdOrders[0].shippingAddressId).toBeTruthy();
      expect(createdOrders[0].billingAddressId).toBeTruthy();
      expect(createdOrders[0].shippingAddressId).toBe(createdOrders[0].billingAddressId);

      const createdOrderLines = await cleanupDb
        .select()
        .from(orderLines)
        .where(eq(orderLines.orderId, createdOrders[0].id));
      expect(createdOrderLines.length).toBe(1);
      expect(createdOrderLines[0].stripePriceId).toBe('price_charge_001');
    });
});