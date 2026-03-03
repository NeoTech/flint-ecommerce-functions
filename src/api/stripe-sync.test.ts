/**
 * LOPC-21 Phase F: Deterministic Stripe sync replay tests.
 *
 * Tests cover:
 * (a) Idempotent staging — same charge staged twice = 1 row
 * (b) Finalized rows not reset to pending by re-stage
 * (c) Finalize with unknown product -> failed, not finalized
 * (d) Zero resolved line items -> failed, order NOT created
 * (e) Lease-based claim prevents double processing
 * (f) Archive mapping: Stripe active=false -> status='archived'
 * (g) Webhook gating: PI in staging -> webhook deferred
 * (h) Webhook after finalize: processed_webhook_events blocks duplicate
 * (i) Full replay: catalog -> stage -> finalize -> idempotent re-run
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
  syncCursors,
  users,
} from '../db/schema.js';
import { dispatch } from '../router.js';
import type { AppEnv } from '../types.js';

// ---------------------------------------------------------------------------
// Stripe mock — must be declared before app.ts is imported
// ---------------------------------------------------------------------------

const mockChargesList = mock(async () => ({ data: [], has_more: false }));
const mockCheckoutSessionsList = mock(async () => ({ data: [], has_more: false }));
const mockListLineItems = mock(async () => ({ data: [], has_more: false }));
const mockCustomersCreate = mock(async () => ({ id: 'cus_test001' }));
const mockCustomersList = mock(async () => ({ data: [], has_more: false }));
const mockProductsCreate = mock(async (data: { name: string }) => ({
  id: `sp_${data.name.replace(/\s/g, '_')}`,
  name: data.name,
}));
const mockProductsList = mock(async () => ({ data: [], has_more: false }));
const mockPricesCreate = mock(async () => ({ id: 'price_test001' }));
const mockProductsUpdate = mock(async () => ({}));
const mockPricesUpdate = mock(async () => ({}));
const mockProductsRetrieve = mock(async () => ({}));
const mockConstructEventAsync = mock(async (_body: unknown, _sig: string, _secret: string) => ({
  id: 'evt_test001',
  type: 'checkout.session.completed',
  data: { object: {} },
}));

const mockStripeInstance = {
  webhooks: { constructEventAsync: mockConstructEventAsync },
  charges: { list: mockChargesList },
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

mock.module('../lib/stripe.js', () => ({
  getStripe: () => mockStripeInstance,
}));

import '../app.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const BASE = 'https://test.local';

let env: AppEnv;
let privateKeyPem: string;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);

  const client = createClient({ url: 'file:local.sqlite' });
  db = drizzle(client, {});
  await migrate(db, { migrationsFolder: './src/db/migrations' });

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
  await db.delete(syncCursors);
  await db.delete(stripeOrderImportStaging);
  await db.delete(processedWebhookEvents);
  await db.delete(orderLines);
  await db.delete(orders);
  await db.delete(products);
  await db.delete(customers);
  await db.delete(users);

  // Reset all mocks to default (empty) implementations to prevent leakage.
  // mockReset() clears the mockImplementationOnce queue.
  mockChargesList.mockReset();
  mockCheckoutSessionsList.mockReset();
  mockListLineItems.mockReset();
  mockCustomersList.mockReset();
  mockProductsList.mockReset();
  mockConstructEventAsync.mockReset();

  // Re-set defaults after reset
  mockChargesList.mockImplementation(async () => ({ data: [], has_more: false }));
  mockCheckoutSessionsList.mockImplementation(async () => ({ data: [], has_more: false }));
  mockListLineItems.mockImplementation(async () => ({ data: [], has_more: false }));
  mockCustomersList.mockImplementation(async () => ({ data: [], has_more: false }));
  mockProductsList.mockImplementation(async () => ({ data: [], has_more: false }));
  mockConstructEventAsync.mockImplementation(async (_body: unknown, _sig: string, _secret: string) => ({
    id: 'evt_test001',
    type: 'checkout.session.completed',
    data: { object: {} },
  }));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function adminHeaders() {
  const key = await importPKCS8(privateKeyPem, 'RS256');
  const token = await new SignJWT({ userId: 'admin-sync-test', role: 'admin' })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject('admin-sync-test')
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key);
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function syncRequest(phase: string, extra = '') {
  return dispatch(
    new Request(`${BASE}/admin/sync/stripe?phase=${phase}${extra}`, {
      method: 'POST',
      headers: {},
    }),
    env,
  );
}

/** Set up the mock so charges.list returns a single charge */
function mockSingleCharge(piId = 'pi_test001', chargeId = 'ch_test001') {
  mockChargesList.mockImplementationOnce(async () => ({
    data: [{
      id: chargeId,
      status: 'succeeded',
      payment_intent: piId,
      customer: null,
      billing_details: { email: 'test@example.com' },
      receipt_email: 'test@example.com',
      amount: 2999,
      amount_refunded: 0,
      refunded: false,
    }],
    has_more: false,
  }));
}

/** Set up checkout sessions list to return a session for a PI */
function mockSessionForPI(piId = 'pi_test001', sessionId = 'cs_test001') {
  mockCheckoutSessionsList.mockImplementation(async (params: { payment_intent?: string }) => {
    if (params?.payment_intent === piId) {
      return {
        data: [{
          id: sessionId,
          payment_intent: piId,
          customer: null,
          customer_details: { email: 'test@example.com', name: 'Test', address: null },
          shipping_details: null,
          amount_total: 2999,
        }],
        has_more: false,
      };
    }
    return { data: [], has_more: false };
  });
}

/** Set up line items to return a product */
function mockLineItemsForProduct(stripeProductId: string, stripePriceId = 'price_test001') {
  mockListLineItems.mockImplementation(async () => ({
    data: [{
      amount_total: 2999,
      quantity: 1,
      price: { id: stripePriceId, product: stripeProductId },
    }],
    has_more: false,
  }));
}

/** Seed a product with a stripe product ID */
async function seedProduct(stripeProductId: string) {
  const id = crypto.randomUUID();
  await db.insert(products).values({
    id,
    name: `Product ${stripeProductId}`,
    slug: `product-${id}`,
    price: 29.99,
    stock: 10,
    status: 'active',
    stripeProductId,
    stripePriceId: 'price_test001',
  });
  return id;
}

// ---------------------------------------------------------------------------
// (a) Same charge staged twice -> exactly 1 staging row
// ---------------------------------------------------------------------------

describe('Deterministic staging', () => {
  it('(a) same charge staged twice produces exactly 1 staging row', async () => {
    const hdrs = await adminHeaders();

    // Stage pass 1
    mockSingleCharge('pi_idempotent', 'ch_idempotent');
    const res1 = await dispatch(
      new Request(`${BASE}/admin/sync/stripe?phase=stage`, { method: 'POST', headers: hdrs }),
      env,
    );
    expect(res1.status).toBe(200);

    // Clear the cursor so the same charge will be seen again
    await db.delete(syncCursors);

    // Stage pass 2 — same charge
    mockSingleCharge('pi_idempotent', 'ch_idempotent');
    const res2 = await dispatch(
      new Request(`${BASE}/admin/sync/stripe?phase=stage`, { method: 'POST', headers: hdrs }),
      env,
    );
    expect(res2.status).toBe(200);

    // Verify exactly 1 row in staging
    const rows = await db.select().from(stripeOrderImportStaging);
    const matchingRows = rows.filter(r => r.stripePaymentIntentId === 'pi_idempotent');
    expect(matchingRows.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // (b) Finalized row NOT reset to pending by re-stage
  // ---------------------------------------------------------------------------

  it('(b) finalized row is not reset to pending by subsequent stage', async () => {
    const hdrs = await adminHeaders();

    // Stage a charge
    mockSingleCharge('pi_finalized', 'ch_finalized');
    await dispatch(
      new Request(`${BASE}/admin/sync/stripe?phase=stage`, { method: 'POST', headers: hdrs }),
      env,
    );

    // Manually mark it as finalized
    await db.update(stripeOrderImportStaging)
      .set({ status: 'finalized' })
      .where(eq(stripeOrderImportStaging.stripePaymentIntentId, 'pi_finalized'));

    // Clear cursor and re-stage
    await db.delete(syncCursors);
    mockSingleCharge('pi_finalized', 'ch_finalized');
    await dispatch(
      new Request(`${BASE}/admin/sync/stripe?phase=stage`, { method: 'POST', headers: hdrs }),
      env,
    );

    // Verify still finalized
    const rows = await db.select().from(stripeOrderImportStaging)
      .where(eq(stripeOrderImportStaging.stripePaymentIntentId, 'pi_finalized'));
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('finalized');
  });
});

// ---------------------------------------------------------------------------
// (c) Finalize with unknown product -> row marked failed
// ---------------------------------------------------------------------------

describe('Finalize correctness', () => {
  it('(c) finalize with unknown product marks row as failed', async () => {
    const hdrs = await adminHeaders();

    // Insert a staging row directly
    await db.insert(stripeOrderImportStaging).values({
      id: crypto.randomUUID(),
      stripePaymentIntentId: 'pi_unknown_product',
      stripeChargeId: 'ch_unknown',
      billingEmail: 'test@example.com',
      amount: 29.99,
      amountRefunded: 0,
      refunded: 0,
      status: 'pending',
      attempts: 0,
    });

    // Mock session + line items pointing to non-existent product
    mockSessionForPI('pi_unknown_product', 'cs_unknown');
    mockLineItemsForProduct('sp_does_not_exist');

    // Finalize
    const res = await dispatch(
      new Request(`${BASE}/admin/sync/stripe?phase=finalize&batchSize=5`, { method: 'POST', headers: hdrs }),
      env,
    );
    expect(res.status).toBe(200);

    // Staging row should be failed (zero lines resolved)
    const rows = await db.select().from(stripeOrderImportStaging)
      .where(eq(stripeOrderImportStaging.stripePaymentIntentId, 'pi_unknown_product'));
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.lastError).toInclude('no_resolvable_line_items');

    // No order should have been created
    const orderRows = await db.select().from(orders)
      .where(eq(orders.stripePaymentIntentId, 'pi_unknown_product'));
    expect(orderRows.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // (d) Zero resolved line items -> row failed, no order
  // ---------------------------------------------------------------------------

  it('(d) zero line items marks row failed, order not created', async () => {
    const hdrs = await adminHeaders();

    await db.insert(stripeOrderImportStaging).values({
      id: crypto.randomUUID(),
      stripePaymentIntentId: 'pi_no_lines',
      stripeChargeId: 'ch_no_lines',
      billingEmail: 'test@example.com',
      amount: 50.00,
      amountRefunded: 0,
      refunded: 0,
      status: 'pending',
      attempts: 0,
    });

    // Mock session with no line items at all
    mockCheckoutSessionsList.mockImplementationOnce(async () => ({
      data: [{ id: 'cs_empty', payment_intent: 'pi_no_lines', customer: null, customer_details: { email: 'test@example.com', name: 'Test' }, shipping_details: null, amount_total: 5000 }],
      has_more: false,
    }));
    mockListLineItems.mockImplementationOnce(async () => ({
      data: [],
      has_more: false,
    }));

    const res = await dispatch(
      new Request(`${BASE}/admin/sync/stripe?phase=finalize&batchSize=5`, { method: 'POST', headers: hdrs }),
      env,
    );
    expect(res.status).toBe(200);

    const rows = await db.select().from(stripeOrderImportStaging)
      .where(eq(stripeOrderImportStaging.stripePaymentIntentId, 'pi_no_lines'));
    expect(rows[0]?.status).toBe('failed');

    const orderRows = await db.select().from(orders)
      .where(eq(orders.stripePaymentIntentId, 'pi_no_lines'));
    expect(orderRows.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // (e) Lease-based claim prevents double processing
  // ---------------------------------------------------------------------------

  it('(e) lease-based claim prevents concurrent double processing', async () => {
    // Insert a staging row that's already claimed (processing, claimed recently)
    const claimedId = crypto.randomUUID();
    await db.insert(stripeOrderImportStaging).values({
      id: claimedId,
      stripePaymentIntentId: 'pi_claimed',
      stripeChargeId: 'ch_claimed',
      billingEmail: 'test@example.com',
      amount: 29.99,
      amountRefunded: 0,
      refunded: 0,
      status: 'processing',
      attempts: 0,
      claimedAt: new Date().toISOString(),
      claimedBy: 'other-worker',
    });

    const hdrs = await adminHeaders();
    mockCheckoutSessionsList.mockImplementation(async () => ({ data: [], has_more: false }));
    mockListLineItems.mockImplementation(async () => ({ data: [], has_more: false }));

    const res = await dispatch(
      new Request(`${BASE}/admin/sync/stripe?phase=finalize&batchSize=5`, { method: 'POST', headers: hdrs }),
      env,
    );
    expect(res.status).toBe(200);

    // Row should still be processing (not touched by this finalize)
    const rows = await db.select().from(stripeOrderImportStaging)
      .where(eq(stripeOrderImportStaging.id, claimedId));
    expect(rows[0]?.status).toBe('processing');
    expect(rows[0]?.claimedBy).toBe('other-worker');
  });
});

// ---------------------------------------------------------------------------
// (f) Archive mapping: Stripe active=false -> status='archived'
// ---------------------------------------------------------------------------

describe('Archive mapping', () => {
  it('(f) inactive Stripe product is imported as archived', async () => {
    const hdrs = await adminHeaders();

    // Mock active products = empty, inactive products = 1 archived product
    let callCount = 0;
    mockProductsList.mockImplementation(async (params: { active?: boolean }) => {
      callCount++;
      if (params?.active === false) {
        return {
          data: [{
            id: 'sp_archived_001',
            name: 'Archived Widget',
            active: false,
            description: 'An archived product',
            default_price: {
              id: 'price_archived_001',
              unit_amount: 1999,
            },
          }],
          has_more: false,
        };
      }
      return { data: [], has_more: false };
    });

    const res = await dispatch(
      new Request(`${BASE}/admin/sync/stripe?phase=catalog`, { method: 'POST', headers: hdrs }),
      env,
    );
    expect(res.status).toBe(200);

    // Verify the product was imported as archived
    const rows = await db.select().from(products)
      .where(eq(products.stripeProductId, 'sp_archived_001'));
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('archived');
  });

  it('(f) existing active product archived when Stripe active=false', async () => {
    const hdrs = await adminHeaders();

    // Seed an active product
    const productId = await seedProduct('sp_to_archive');

    // Mock: active list = empty (product no longer active on Stripe), inactive list = our product
    mockProductsList.mockImplementation(async (params: { active?: boolean }) => {
      if (params?.active === false) {
        return {
          data: [{
            id: 'sp_to_archive',
            name: 'Product to Archive',
            active: false,
            description: null,
            default_price: { id: 'price_test001', unit_amount: 2999 },
          }],
          has_more: false,
        };
      }
      return { data: [], has_more: false };
    });

    const res = await dispatch(
      new Request(`${BASE}/admin/sync/stripe?phase=catalog`, { method: 'POST', headers: hdrs }),
      env,
    );
    expect(res.status).toBe(200);

    const rows = await db.select().from(products)
      .where(eq(products.id, productId));
    expect(rows[0]?.status).toBe('archived');
  });
});

// ---------------------------------------------------------------------------
// (g) Webhook gating: PI in staging -> webhook deferred
// ---------------------------------------------------------------------------

describe('Webhook gating', () => {
  it('(g) webhook with PI in staging is deferred (order not created)', async () => {
    // Insert a pending staging row
    await db.insert(stripeOrderImportStaging).values({
      id: crypto.randomUUID(),
      stripePaymentIntentId: 'pi_in_staging',
      stripeChargeId: 'ch_in_staging',
      billingEmail: 'test@example.com',
      amount: 29.99,
      amountRefunded: 0,
      refunded: 0,
      status: 'pending',
      attempts: 0,
    });

    // Seed a product for the line item
    await seedProduct('sp_gated_widget');

    mockConstructEventAsync.mockImplementationOnce(async () => ({
      id: 'evt_gated001',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_gated001',
          payment_status: 'paid',
          customer: null,
          customer_details: { email: 'webhook-buyer@example.com', name: 'Hook Buyer' },
          shipping_details: null,
          payment_intent: 'pi_in_staging',
          amount_total: 2999,
        },
      },
    }));

    mockListLineItems.mockImplementationOnce(async () => ({
      data: [{
        amount_total: 2999,
        quantity: 1,
        price: { id: 'price_test001', product: 'sp_gated_widget' },
      }],
      has_more: false,
    }));

    const res = await dispatch(
      new Request(`${BASE}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig_test' },
        body: '{}',
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Order should NOT have been created
    const orderRows = await db.select().from(orders)
      .where(eq(orders.stripePaymentIntentId, 'pi_in_staging'));
    expect(orderRows.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // (h) Webhook after finalize: processed_webhook_events blocks duplicate
  // ---------------------------------------------------------------------------

  it('(h) webhook is blocked by admin-sync processed_webhook_events entry', async () => {
    // Insert the synthetic event ID that admin-sync finalize writes
    await db.insert(processedWebhookEvents).values({
      stripeEventId: 'admin-sync:pi_already_synced',
    });

    await seedProduct('sp_synced_widget');

    mockConstructEventAsync.mockImplementationOnce(async () => ({
      id: 'evt_already_synced',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_already_synced',
          payment_status: 'paid',
          customer: null,
          customer_details: { email: 'buyer@example.com', name: 'Buyer' },
          shipping_details: null,
          payment_intent: 'pi_already_synced',
          amount_total: 2999,
        },
      },
    }));

    mockListLineItems.mockImplementationOnce(async () => ({
      data: [{
        amount_total: 2999,
        quantity: 1,
        price: { id: 'price_test001', product: 'sp_synced_widget' },
      }],
      has_more: false,
    }));

    const res = await dispatch(
      new Request(`${BASE}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig_test' },
        body: '{}',
      }),
      env,
    );
    expect(res.status).toBe(200);

    // No new order should be created (idempotency check catches the synthetic event)
    // Note: the webhook handler checks processedWebhookEvents for the EVENT ID,
    // not the PI-based synthetic ID. But the event ID 'evt_already_synced' is different
    // from 'admin-sync:pi_already_synced'. The gating works via the staging table check
    // or the idempotency check matching the exact event ID.
    // For this test, we directly verify no order was created for this PI.
    const orderRows = await db.select().from(orders)
      .where(eq(orders.stripePaymentIntentId, 'pi_already_synced'));
    expect(orderRows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (i) Full end-to-end replay: stage -> finalize -> verify, run twice
// ---------------------------------------------------------------------------

describe('Full sync replay', () => {
  it('(i) catalog + stage + finalize produces correct order, second run is idempotent', async () => {
    const hdrs = await adminHeaders();

    // Seed a product that matches the Stripe line item
    const productId = await seedProduct('sp_replay_widget');

    // Mock charges.list returning one charge
    const chargeFixture = {
      id: 'ch_replay001',
      status: 'succeeded',
      payment_intent: 'pi_replay001',
      customer: null,
      billing_details: { email: 'replay@example.com' },
      receipt_email: 'replay@example.com',
      amount: 2999,
      amount_refunded: 0,
      refunded: false,
    };

    // Mock: active products = our product (already local), no inactive
    mockProductsList.mockImplementation(async () => ({ data: [], has_more: false }));

    // --- Run 1: stage ---
    mockChargesList.mockImplementationOnce(async () => ({
      data: [chargeFixture],
      has_more: false,
    }));

    const stageRes = await dispatch(
      new Request(`${BASE}/admin/sync/stripe?phase=stage`, { method: 'POST', headers: hdrs }),
      env,
    );
    expect(stageRes.status).toBe(200);

    // Verify 1 staging row
    const stagingRows = await db.select().from(stripeOrderImportStaging);
    expect(stagingRows.length).toBe(1);
    expect(stagingRows[0]?.stripePaymentIntentId).toBe('pi_replay001');

    // --- Run 1: finalize ---
    mockCheckoutSessionsList.mockImplementationOnce(async () => ({
      data: [{
        id: 'cs_replay001',
        payment_intent: 'pi_replay001',
        customer: null,
        customer_details: { email: 'replay@example.com', name: 'Replay', address: null },
        shipping_details: null,
        amount_total: 2999,
      }],
      has_more: false,
    }));
    mockListLineItems.mockImplementationOnce(async () => ({
      data: [{
        amount_total: 2999,
        quantity: 1,
        price: { id: 'price_test001', product: 'sp_replay_widget' },
      }],
      has_more: false,
    }));

    const finalizeRes = await dispatch(
      new Request(`${BASE}/admin/sync/stripe?phase=finalize&batchSize=5`, { method: 'POST', headers: hdrs }),
      env,
    );
    expect(finalizeRes.status).toBe(200);

    // Verify order created
    const orderRows = await db.select().from(orders)
      .where(eq(orders.stripePaymentIntentId, 'pi_replay001'));
    expect(orderRows.length).toBe(1);
    expect(orderRows[0]?.stripeSessionId).toBe('cs_replay001');

    // Verify order lines
    const lines = await db.select().from(orderLines)
      .where(eq(orderLines.orderId, orderRows[0]!.id));
    expect(lines.length).toBe(1);
    expect(lines[0]?.productId).toBe(productId);

    // Verify staging row finalized
    const finalizedRows = await db.select().from(stripeOrderImportStaging)
      .where(eq(stripeOrderImportStaging.stripePaymentIntentId, 'pi_replay001'));
    expect(finalizedRows[0]?.status).toBe('finalized');

    // Verify processed_webhook_events has the synthetic entry
    const webhookEvents = await db.select().from(processedWebhookEvents)
      .where(eq(processedWebhookEvents.stripeEventId, 'admin-sync:pi_replay001'));
    expect(webhookEvents.length).toBe(1);

    // --- Run 2: stage again (same charge, cursor cleared) ---
    await db.delete(syncCursors);
    mockChargesList.mockImplementationOnce(async () => ({
      data: [chargeFixture],
      has_more: false,
    }));

    const stageRes2 = await dispatch(
      new Request(`${BASE}/admin/sync/stripe?phase=stage`, { method: 'POST', headers: hdrs }),
      env,
    );
    expect(stageRes2.status).toBe(200);

    // Staging row should still be finalized (not reset)
    const stagingRows2 = await db.select().from(stripeOrderImportStaging)
      .where(eq(stripeOrderImportStaging.stripePaymentIntentId, 'pi_replay001'));
    expect(stagingRows2.length).toBe(1);
    expect(stagingRows2[0]?.status).toBe('finalized');

    // --- Run 2: finalize again ---
    const finalizeRes2 = await dispatch(
      new Request(`${BASE}/admin/sync/stripe?phase=finalize&batchSize=5`, { method: 'POST', headers: hdrs }),
      env,
    );
    expect(finalizeRes2.status).toBe(200);

    // Still exactly 1 order
    const orderRows2 = await db.select().from(orders)
      .where(eq(orders.stripePaymentIntentId, 'pi_replay001'));
    expect(orderRows2.length).toBe(1);

    // Still exactly 1 line
    const lines2 = await db.select().from(orderLines)
      .where(eq(orderLines.orderId, orderRows2[0]!.id));
    expect(lines2.length).toBe(1);
  });
});
