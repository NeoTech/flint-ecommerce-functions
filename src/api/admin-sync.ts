/**
 * Admin Stripe sync routes.
 *
 * POST /admin/sync/stripe  — reconcile local DB against Stripe (admin only)
 *
 * Useful when Stripe data has drifted (e.g. products imported directly into
 * Stripe, customer IDs missing from local rows, etc.).
 */
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { registerRoute } from '../router.js';
import { getDb } from '../db/client.js';
import { addresses, customers, orders, products, stripeOrderImportStaging, syncCursors, users } from '../db/schema.js';
import { getStripe } from '../lib/stripe.js';
import { mapStripeProductStatus } from '../lib/stripe-product-status.js';
import { badRequest, ok, serverError } from '../types.js';
import type Stripe from 'stripe';

const PLACEHOLDER_USER_ID = '00000000-0000-0000-0000-00000000a001';
const PLACEHOLDER_CUSTOMER_ID = '00000000-0000-0000-0000-00000000a002';
const PLACEHOLDER_ADDRESS_ID = '00000000-0000-0000-0000-00000000a003';
const PLACEHOLDER_EMAIL = 'system+missing-address@local.invalid';
const FINALIZE_BATCH_SIZE = 10;

type RawClient = {
  execute: (input: { sql: string; args?: unknown[] } | string) => Promise<unknown>;
};

function isUsableStripeAddress(address: Stripe.Address | null | undefined): address is Stripe.Address {
  return Boolean(address && (address.line1 || address.city || address.state || address.postal_code || address.country));
}

async function resolveAddressIdForOrder(
  rawClient: RawClient,
  customerId: string,
  address: Stripe.Address | null | undefined,
  placeholderAddressId: string,
): Promise<string> {
  if (!isUsableStripeAddress(address)) return placeholderAddressId;

  const street = (address.line1 ?? '').trim();
  const city = (address.city ?? '').trim();
  const state = address.state?.trim() || null;
  const postalCode = (address.postal_code ?? '').trim();
  const country = (address.country ?? 'XX').trim();

  const existing = await rawClient.execute({
    sql: `SELECT id
          FROM addresses
          WHERE customer_id = ?
            AND street = ?
            AND city = ?
            AND IFNULL(state, '') = ?
            AND postal_code = ?
            AND country = ?
          LIMIT 1`,
    args: [customerId, street, city, state ?? '', postalCode, country],
  }) as { rows?: unknown[][] };

  const existingId = existing.rows?.[0]?.[0];
  if (existingId) return String(existingId);

  const addressId = crypto.randomUUID();
  await rawClient.execute({
    sql: `INSERT INTO addresses (id, customer_id, type, street, city, state, postal_code, country, is_default)
          VALUES (?, ?, 'shipping', ?, ?, ?, ?, ?, 0)`,
    args: [addressId, customerId, street, city, state, postalCode, country],
  });
  return addressId;
}

async function insertOrderLinesFromStripeSession(
  rawClient: RawClient,
  stripe: ReturnType<typeof getStripe>,
  paymentIntentId: string,
  orderId: string,
  knownSessionId?: string | null,
): Promise<number> {
  let sessionId = knownSessionId ?? null;
  if (!sessionId) {
    const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
    const session = sessions.data[0];
    if (!session) return 0;
    sessionId = session.id;
  }

  const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, {
    limit: 100,
    expand: ['data.price.product'],
  });

  let insertedCount = 0;
  for (const item of lineItems.data) {
    const stripePriceId = item.price?.id ?? null;
    const stripeProductId =
      item.price && typeof item.price.product === 'string'
        ? item.price.product
        : (item.price?.product as Stripe.Product | null)?.id ?? null;

    if (!stripeProductId) continue;

    const quantity = item.quantity ?? 1;
    const lineTotal = (item.amount_total ?? 0) / 100;
    const unitPrice = lineTotal / quantity;

    const productRow = await rawClient.execute({
      sql: 'SELECT id FROM products WHERE stripe_product_id = ? LIMIT 1',
      args: [stripeProductId],
    }) as { rows?: unknown[][] };

    let productId = productRow.rows?.[0]?.[0];
    if (!productId) {
      console.warn(`[admin-sync] Line item references unknown product ${stripeProductId}, skipping`);
      continue;
    }

    await rawClient.execute({
      sql: `INSERT INTO order_lines (id, order_id, product_id, variant_id, quantity, unit_price, line_total, stripe_price_id)
            VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      args: [crypto.randomUUID(), orderId, String(productId), quantity, unitPrice, lineTotal, stripePriceId],
    });
    insertedCount++;
  }
  return insertedCount;
}

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function uniqueSlug(base: string, db: ReturnType<typeof getDb>): Promise<string> {
  let slug = base;
  let n = 2;
  for (;;) {
    const rows = await db.select({ id: products.id }).from(products).where(eq(products.slug, slug));
    if (rows.length === 0) return slug;
    slug = `${base}-${n++}`;
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 6, delayMs = 150): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }
  throw lastError;
}

async function ensurePlaceholderRecords(db: ReturnType<typeof getDb>): Promise<{ customerId: string; addressId: string }> {
  return await withRetry(() =>
    db.transaction(async (tx) => {
      let placeholderUserId = PLACEHOLDER_USER_ID;

      const byId = (
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, PLACEHOLDER_USER_ID))
      )[0];

      if (!byId) {
        const byEmail = (
          await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, PLACEHOLDER_EMAIL))
        )[0];

        if (byEmail) {
          placeholderUserId = byEmail.id;
        } else {
          await tx.insert(users).values({
            id: PLACEHOLDER_USER_ID,
            email: PLACEHOLDER_EMAIL,
            passwordHash: '',
            role: 'customer',
            stripeCustomerId: null,
          }).onConflictDoNothing();
          placeholderUserId = PLACEHOLDER_USER_ID;
        }
      }

      const placeholderCustomerById = (
        await tx
          .select({ id: customers.id, userId: customers.userId })
          .from(customers)
          .where(eq(customers.id, PLACEHOLDER_CUSTOMER_ID))
      )[0];

      let placeholderCustomerId = PLACEHOLDER_CUSTOMER_ID;
      if (placeholderCustomerById) {
        placeholderCustomerId = placeholderCustomerById.id;
      } else {
        const placeholderCustomerByUser = (
          await tx
            .select({ id: customers.id })
            .from(customers)
            .where(eq(customers.userId, placeholderUserId))
        )[0];

        if (placeholderCustomerByUser) {
          placeholderCustomerId = placeholderCustomerByUser.id;
        } else {
          await tx.insert(customers).values({
            id: PLACEHOLDER_CUSTOMER_ID,
            userId: placeholderUserId,
            firstName: 'Missing',
            lastName: 'Address',
            phone: null,
          }).onConflictDoNothing();
          placeholderCustomerId = PLACEHOLDER_CUSTOMER_ID;
        }
      }

      const placeholderAddressById = (
        await tx
          .select({ id: addresses.id })
          .from(addresses)
          .where(eq(addresses.id, PLACEHOLDER_ADDRESS_ID))
      )[0];

      let placeholderAddressId = PLACEHOLDER_ADDRESS_ID;
      if (placeholderAddressById) {
        placeholderAddressId = placeholderAddressById.id;
      } else {
        const placeholderAddressByCustomer = (
          await tx
            .select({ id: addresses.id })
            .from(addresses)
            .where(eq(addresses.customerId, placeholderCustomerId))
        )[0];

        if (placeholderAddressByCustomer) {
          placeholderAddressId = placeholderAddressByCustomer.id;
        } else {
          await tx.insert(addresses).values({
            id: PLACEHOLDER_ADDRESS_ID,
            customerId: placeholderCustomerId,
            type: 'shipping',
            street: 'Missing address',
            city: 'No city',
            state: null,
            postalCode: '00000',
            country: 'XX',
            isDefault: false,
          }).onConflictDoNothing();
          placeholderAddressId = PLACEHOLDER_ADDRESS_ID;
        }
      }

      return {
        customerId: placeholderCustomerId,
        addressId: placeholderAddressId,
      };
    }),
  );
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    const anyErr = err as Error & { cause?: unknown; code?: string };
    const cause = anyErr.cause
      ? ` | cause=${typeof anyErr.cause === 'object' ? JSON.stringify(anyErr.cause) : String(anyErr.cause)}`
      : '';
    const code = anyErr.code ? ` | code=${anyErr.code}` : '';
    return `${anyErr.name}: ${anyErr.message}${code}${cause}`;
  }
  return String(err);
}

// ---- POST /admin/sync/stripe ------------------------------------------------

registerRoute({
  method: 'POST',
  path: '/admin/sync/stripe',
  auth: 'admin',
  description:
    'Reconcile local database against Stripe. Updates stripe_product_id / stripe_price_id on products and stripe_customer_id on users.',
  handler: async (request, ctx) => {
    const db = getDb(ctx.env);
    const rawClient = (db as unknown as { $client: RawClient }).$client;
    const stripe = getStripe(ctx.env);

    const productStats = { imported: 0, created: 0, synced: 0, upToDate: 0, archived: 0, importedArchived: 0 };
    const customerStats = { imported: 0, synced: 0, created: 0, upToDate: 0 };
    const orderStats = { staged: 0, finalized: 0, skipped: 0, failed: 0 };
      const orderSkipReasons: {
        alreadyImported: number;
        alreadyStaged: number;
        noPaymentIntent: number;
        noCustomerOrEmail: number;
        processingError: number;
      } = {
        alreadyImported: 0,
        alreadyStaged: 0,
        noPaymentIntent: 0,
        noCustomerOrEmail: 0,
        processingError: 0,
      };
    const orderProcessingErrors: Record<string, number> = {};

    const url = new URL(request.url);
    const phaseParam = (url.searchParams.get('phase') ?? 'all').toLowerCase();
    if (!['all', 'catalog', 'stage', 'finalize', 'status'].includes(phaseParam)) {
      return badRequest('Invalid phase. Use all, catalog, stage, finalize, or status.');
    }

    const phase = phaseParam as 'all' | 'catalog' | 'stage' | 'finalize' | 'status';
    const batchSizeRaw = Number(url.searchParams.get('batchSize') ?? url.searchParams.get('finalizeBatch') ?? String(FINALIZE_BATCH_SIZE));
    const finalizeBatch = Number.isFinite(batchSizeRaw)
      ? Math.min(50, Math.max(1, Math.floor(batchSizeRaw)))
      : FINALIZE_BATCH_SIZE;

    if (phase === 'status') {
      const stagingStatuses = await db
        .select({ status: stripeOrderImportStaging.status, claimedAt: stripeOrderImportStaging.claimedAt })
        .from(stripeOrderImportStaging);

      const now = Date.now();
      const fiveMinMs = 5 * 60 * 1000;
      const backlog = { pending: 0, failed: 0, finalized: 0, staleProcessing: 0 };
      for (const row of stagingStatuses) {
        if (row.status === 'pending') backlog.pending++;
        else if (row.status === 'failed') backlog.failed++;
        else if (row.status === 'finalized') backlog.finalized++;
        else if (row.status === 'processing') {
          const claimedMs = row.claimedAt ? new Date(row.claimedAt).getTime() : 0;
          if (now - claimedMs > fiveMinMs) backlog.staleProcessing++;
        }
      }

      return ok({
        phase,
        products: productStats,
        customers: customerStats,
        orders: {
          ...orderStats,
          backlog,
          remainingToFinalize: backlog.pending + backlog.failed + backlog.staleProcessing,
        },
      });
    }

    const runCatalogSync = phase === 'all' || phase === 'catalog';
    const runStage = phase === 'all' || phase === 'stage';
    const runFinalize = phase === 'all' || phase === 'finalize';

    if (runCatalogSync) {

    // Build a set of stripeProductIds already known locally (shared by Step 1 & 1b).
    const localProducts = await db.select().from(products);
    const knownStripeIds = new Set(localProducts.map((p) => p.stripeProductId).filter(Boolean));

    // ---- Step 1: Import Stripe products that are missing from local DB ------
    try {

      // Page through all active Stripe products.
      let hasMore = true;
      let startingAfter: string | undefined;

      while (hasMore) {
        const page = await stripe.products.list({
          active: true,
          limit: 100,
          expand: ['data.default_price'],
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });

        for (const sp of page.data) {
          if (knownStripeIds.has(sp.id)) continue;

          const expandedDefaultPrice =
            typeof sp.default_price === 'object' && sp.default_price
              ? sp.default_price
              : null;

          // Prefer expanded default price to avoid extra API calls.
          const stripePrice = expandedDefaultPrice && expandedDefaultPrice.unit_amount !== null
            ? expandedDefaultPrice
            : (await stripe.prices.list({ product: sp.id, active: true, limit: 1 })).data[0];
          if (!stripePrice || stripePrice.unit_amount === null) continue;

          const price = stripePrice.unit_amount / 100;
          const slug = await uniqueSlug(toSlug(sp.name), db);

          await db.insert(products).values({
            name: sp.name,
            slug,
            description: sp.description ?? null,
            price,
            stock: 0,
            status: mapStripeProductStatus(sp),
            stripeProductId: sp.id,
            stripePriceId: stripePrice.id,
          });

          knownStripeIds.add(sp.id);
          productStats.imported++;
        }

        hasMore = page.has_more;
        startingAfter = page.data[page.data.length - 1]?.id;
      }
    } catch (err) {
      console.error('[admin-sync] Stripe → local product import error:', err);
      return serverError('Product import from Stripe failed');
    }

    // ---- Step 1b: Import/archive inactive Stripe products -------------------
    try {
      let hasMore = true;
      let startingAfter: string | undefined;

      while (hasMore) {
        const page = await stripe.products.list({
          active: false,
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });

        for (const sp of page.data) {
          if (knownStripeIds.has(sp.id)) {
            // Product exists locally — archive if not already.
            const localRow = (await db.select().from(products).where(eq(products.stripeProductId, sp.id)))[0];
            if (localRow && localRow.status !== 'archived') {
              await db.update(products)
                .set({ status: 'archived', updatedAt: sql`(datetime('now'))` })
                .where(eq(products.stripeProductId, sp.id));
              productStats.archived++;
            }
            continue;
          }

          // Not known locally — import as archived.
          const expandedDefaultPrice =
            typeof sp.default_price === 'object' && sp.default_price
              ? sp.default_price
              : null;

          const stripePrice = expandedDefaultPrice && expandedDefaultPrice.unit_amount !== null
            ? expandedDefaultPrice
            : (await stripe.prices.list({ product: sp.id, limit: 1 })).data[0];
          if (!stripePrice || stripePrice.unit_amount === null) continue;

          const price = stripePrice.unit_amount / 100;
          const slug = await uniqueSlug(toSlug(sp.name), db);

          await db.insert(products).values({
            name: sp.name,
            slug,
            description: sp.description ?? null,
            price,
            stock: 0,
            status: 'archived',
            stripeProductId: sp.id,
            stripePriceId: stripePrice.id,
          });

          knownStripeIds.add(sp.id);
          productStats.importedArchived++;
        }

        hasMore = page.has_more;
        startingAfter = page.data[page.data.length - 1]?.id;
      }
    } catch (err) {
      console.error('[admin-sync] Stripe → local inactive product import error:', err);
      return serverError('Inactive product import from Stripe failed');
    }

    // ---- Step 2: Push local products that lack Stripe IDs → Stripe ----------
    try {
      const localProducts = await db.select().from(products);

      for (const product of localProducts) {
        if (product.stripeProductId && product.stripePriceId) {
          productStats.upToDate++;
        } else {
          // No Stripe IDs — create.
          const sp = await stripe.products.create({
            name: product.name,
            ...(product.description ? { description: product.description } : {}),
            metadata: { productId: product.id },
          });
          const spr = await stripe.prices.create({
            product: sp.id,
            unit_amount: Math.round(product.price * 100),
            currency: 'usd',
            metadata: { productId: product.id },
          });
          await db.update(products)
            .set({ stripeProductId: sp.id, stripePriceId: spr.id })
            .where(eq(products.id, product.id));
          productStats.created++;
        }
      }
    } catch (err) {
      console.error('[admin-sync] Product sync error:', err);
      return serverError('Product sync failed');
    }

    // ---- Step 3: Import Stripe customers that are missing from local DB -----
    try {
      const localUsers = await db.select().from(users);
      const usersByEmail = new Map(localUsers.map((u) => [u.email, u]));
      const knownEmails = new Set(localUsers.map((u) => u.email));

      let hasMore = true;
      let startingAfter: string | undefined;

      while (hasMore) {
        const page = await stripe.customers.list({
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });

        for (const sc of page.data) {
          if (!sc.email) continue;

          if (knownEmails.has(sc.email)) {
            // Local user exists — ensure stripeCustomerId is linked.
            const localUser = usersByEmail.get(sc.email);
            if (localUser && !localUser.stripeCustomerId) {
              await db.update(users)
                .set({ stripeCustomerId: sc.id })
                .where(eq(users.id, localUser.id));
              customerStats.synced++;
              usersByEmail.set(sc.email, { ...localUser, stripeCustomerId: sc.id });
            } else {
              customerStats.upToDate++;
            }
            continue;
          }

          // No local user — create one as a guest customer.
          const name = sc.name ?? '';
          const [firstName, ...rest] = name.split(' ');
          const lastName = rest.join(' ') || '-';
          const userId = crypto.randomUUID();

          await db.insert(users).values({
            id: userId,
            email: sc.email,
            passwordHash: '',
            role: 'customer',
            stripeCustomerId: sc.id,
          });
          await db.insert(customers).values({
            id: crypto.randomUUID(),
            userId,
            firstName: firstName || sc.email,
            lastName,
          });

          knownEmails.add(sc.email);
          usersByEmail.set(sc.email, {
            id: userId,
            email: sc.email,
            passwordHash: '',
            role: 'customer',
            stripeCustomerId: sc.id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          customerStats.imported++;
        }

        hasMore = page.has_more;
        startingAfter = page.data[page.data.length - 1]?.id;
      }
    } catch (err) {
      console.error('[admin-sync] Customer import error:', err);
      return serverError('Customer import from Stripe failed');
    }

    // ---- Step 4: Push local users without Stripe Customer IDs → Stripe ------
    try {
      const localUsers = await db.select().from(users);

      for (const user of localUsers) {
        if (user.stripeCustomerId) {
          // Already counted as skipped in step 3, skip here silently.
          continue;
        }

        const existing = await stripe.customers.list({ email: user.email, limit: 1 });
        if (existing.data.length > 0) {
          const existingCustomerId = existing.data[0]?.id;
          if (!existingCustomerId) continue;
          await db.update(users)
            .set({ stripeCustomerId: existingCustomerId })
            .where(eq(users.id, user.id));
          customerStats.synced++;
        } else {
          const sc = await stripe.customers.create({
            email: user.email,
            metadata: { userId: user.id },
          });
          await db.update(users)
            .set({ stripeCustomerId: sc.id })
            .where(eq(users.id, user.id));
          customerStats.created++;
        }
      }
    } catch (err) {
      console.error('[admin-sync] Customer push error:', err);
      return serverError('Customer sync failed');
    }

    }

    // ---- Step 5: Two-phase order import (stage -> finalize) -----------------
    try {
      const placeholders = await ensurePlaceholderRecords(db);

      let lastProcessedChargeId: string | undefined;
      if (runStage) {
        const knownPaymentIntents = new Set<string>();
        // From orders table
        const orderPIs = await db.select({ piId: orders.stripePaymentIntentId }).from(orders);
        for (const o of orderPIs) {
          if (o.piId) knownPaymentIntents.add(o.piId);
        }
        // From staging table (already staged, don't re-upsert)
        const stagedPIs = await db.select({ piId: stripeOrderImportStaging.stripePaymentIntentId }).from(stripeOrderImportStaging);
        for (const s of stagedPIs) {
          if (s.piId) knownPaymentIntents.add(s.piId);
        }

        const cursorRow = await db.select().from(syncCursors).where(eq(syncCursors.id, 'stripe_charges'));
        let startingAfter: string | undefined = cursorRow[0]?.cursorValue ?? undefined;
        let hasMore = true;
        while (hasMore) {
          const page = await stripe.charges.list({
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          });

          for (const charge of page.data) {
            if (charge.status !== 'succeeded') continue;

            const piId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
            if (!piId) {
              orderStats.skipped++;
              orderSkipReasons.noPaymentIntent++;
              continue;
            }

            if (knownPaymentIntents.has(piId)) {
              orderStats.skipped++;
              orderSkipReasons.alreadyImported++;
              continue;
            }

            await withRetry(
              () => rawClient.execute({
                sql: `INSERT INTO stripe_order_import_staging (
                        id,
                        stripe_payment_intent_id,
                        stripe_charge_id,
                        stripe_customer_id,
                        billing_email,
                        amount,
                        amount_refunded,
                        refunded,
                        status,
                        attempts,
                        last_error,
                        created_at,
                        updated_at
                      ) VALUES (
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        'pending',
                        0,
                        NULL,
                        datetime('now'),
                        datetime('now')
                      )
                      ON CONFLICT(stripe_payment_intent_id) DO UPDATE SET
                        stripe_charge_id = excluded.stripe_charge_id,
                        stripe_customer_id = excluded.stripe_customer_id,
                        billing_email = excluded.billing_email,
                        amount = excluded.amount,
                        amount_refunded = excluded.amount_refunded,
                        refunded = excluded.refunded,
                        status = CASE WHEN stripe_order_import_staging.status IN ('finalized') THEN stripe_order_import_staging.status ELSE 'pending' END,
                        updated_at = datetime('now')`,
                args: [
                  crypto.randomUUID(),
                  piId,
                  charge.id,
                  typeof charge.customer === 'string' ? charge.customer : null,
                  charge.billing_details?.email ?? charge.receipt_email ?? null,
                  charge.amount / 100,
                  (charge.amount_refunded ?? 0) / 100,
                  charge.refunded ? 1 : 0,
                ],
              }),
              20,
              300,
            );

            orderStats.staged++;
          }

          hasMore = page.has_more;
          const lastPageChargeId = page.data[page.data.length - 1]?.id;
          if (lastPageChargeId) lastProcessedChargeId = lastPageChargeId;
          startingAfter = lastPageChargeId;
        }

        if (lastProcessedChargeId) {
          await db.insert(syncCursors).values({
            id: 'stripe_charges',
            cursorType: 'charges',
            cursorValue: lastProcessedChargeId,
            updatedAt: new Date().toISOString(),
          }).onConflictDoUpdate({
            target: syncCursors.id,
            set: { cursorValue: lastProcessedChargeId, updatedAt: new Date().toISOString() },
          });
        }
      }

      if (runFinalize) {
        const localUsers = await db.select().from(users);
        const localCustomers = await db.select().from(customers);
        const usersByStripeCustomerId = new Map(
          localUsers
            .filter((u) => Boolean(u.stripeCustomerId))
            .map((u) => [u.stripeCustomerId as string, u]),
        );
        const usersByEmail = new Map(localUsers.map((u) => [u.email, u]));
        const customersByUserId = new Map(localCustomers.map((c) => [c.userId, c]));

        const claimId = crypto.randomUUID();
        await rawClient.execute({
          sql: `UPDATE stripe_order_import_staging
                SET status = 'processing', claimed_at = datetime('now'), claimed_by = ?
                WHERE id IN (
                  SELECT id FROM stripe_order_import_staging
                  WHERE (
                    status IN ('pending', 'failed')
                    OR (status = 'processing' AND claimed_at < datetime('now', '-5 minutes'))
                  )
                  ORDER BY created_at ASC, id ASC
                  LIMIT ?
                )`,
          args: [claimId, finalizeBatch],
        });
        const stagedRows = await db
          .select()
          .from(stripeOrderImportStaging)
          .where(eq(stripeOrderImportStaging.claimedBy, claimId));

        for (const staged of stagedRows) {
          try {
            const userRow =
              (staged.stripeCustomerId ? usersByStripeCustomerId.get(staged.stripeCustomerId) : undefined)
              ?? (staged.billingEmail ? usersByEmail.get(staged.billingEmail) : undefined)
              ?? undefined;

            const customerId = userRow
              ? (customersByUserId.get(userRow.id)?.id ?? placeholders.customerId)
              : placeholders.customerId;

            const sessionList = await withRetry(
              () => stripe.checkout.sessions.list({ payment_intent: staged.stripePaymentIntentId, limit: 1 }),
              8,
              200,
            );
            const session = sessionList.data[0] ?? null;
            const sessionWithShipping = session as (Stripe.Checkout.Session & {
              shipping_details?: { address?: Stripe.Address | null };
            }) | null;

            const stripeAddress =
              sessionWithShipping?.shipping_details?.address
              ?? session?.customer_details?.address
              ?? null;

            const resolvedAddressId = await resolveAddressIdForOrder(
              rawClient,
              customerId,
              stripeAddress,
              placeholders.addressId,
            );

            const existingOrderBefore = await withRetry(
              () => rawClient.execute({
                sql: 'SELECT id FROM orders WHERE stripe_payment_intent_id = ? LIMIT 1',
                args: [staged.stripePaymentIntentId],
              }),
              6,
              150,
            ) as { rows?: unknown[][] };

            const existingOrderBeforeId = existingOrderBefore.rows?.[0]?.[0]
              ? String(existingOrderBefore.rows[0][0])
              : null;

            const newOrderId = crypto.randomUUID();

            const orderStatus = (staged.refunded === 1 && staged.amountRefunded >= staged.amount) ? 'refunded' : 'confirmed';
            const orderNotes = staged.refunded === 1
              ? (staged.amountRefunded >= staged.amount ? 'fully refunded' : 'partially refunded')
              : null;

            await withRetry(
              () => rawClient.execute({
                sql: `INSERT INTO orders (
                        id,
                        customer_id,
                        status,
                        subtotal,
                        tax,
                        shipping_cost,
                        total,
                        refunded_amount,
                        notes,
                        source,
                        stripe_session_id,
                        stripe_payment_intent_id,
                        shipping_address_id,
                        billing_address_id,
                        created_at,
                        updated_at
                      ) VALUES (
                        ?,
                        ?,
                        ?,
                        ?,
                        0,
                        0,
                        ?,
                        ?,
                        ?,
                        'stripe',
                        ?,
                        ?,
                        ?,
                        ?,
                        datetime('now'),
                        datetime('now')
                      )
                      ON CONFLICT(stripe_payment_intent_id) DO NOTHING`,
                args: [
                  newOrderId,
                  customerId,
                  orderStatus,
                  staged.amount,
                  staged.amount,
                  staged.amountRefunded,
                  orderNotes,
                  session?.id ?? null,
                  staged.stripePaymentIntentId,
                  resolvedAddressId,
                  resolvedAddressId,
                ],
              }),
              20,
              500,
            );

            const existingOrderAfter = await withRetry(
              () => rawClient.execute({
                sql: 'SELECT id FROM orders WHERE stripe_payment_intent_id = ? LIMIT 1',
                args: [staged.stripePaymentIntentId],
              }),
              6,
              150,
            ) as { rows?: unknown[][] };

            const targetOrderId = existingOrderAfter.rows?.[0]?.[0]
              ? String(existingOrderAfter.rows[0][0])
              : null;

            if (targetOrderId) {
              const lineCountResult = await withRetry(
                () => rawClient.execute({
                  sql: 'SELECT COUNT(*) FROM order_lines WHERE order_id = ?',
                  args: [targetOrderId],
                }),
                6,
                150,
              ) as { rows?: unknown[][] };
              const currentLineCount = Number(lineCountResult.rows?.[0]?.[0] ?? 0);

              if (currentLineCount === 0) {
                const linesInserted = await withRetry(
                  () => insertOrderLinesFromStripeSession(rawClient, stripe, staged.stripePaymentIntentId, targetOrderId, session?.id ?? null),
                  6,
                  200,
                );

                // Step 11+12: Post-finalize integrity check — zero lines means failure
                if (linesInserted === 0) {
                  // Rollback: delete the order we just created (only if we created it)
                  if (!existingOrderBeforeId) {
                    await rawClient.execute({
                      sql: 'DELETE FROM orders WHERE id = ?',
                      args: [targetOrderId],
                    });
                  }
                  await withRetry(
                    () => rawClient.execute({
                      sql: `UPDATE stripe_order_import_staging
                            SET status='failed', last_error='no_resolvable_line_items', attempts=?, updated_at=datetime('now')
                            WHERE id=?`,
                      args: [staged.attempts + 1, staged.id],
                    }),
                    10,
                    200,
                  );
                  orderStats.failed++;
                  continue;
                }
              }

              // Step 12: Verify order + lines exist after insert
              const verifyLines = await rawClient.execute({
                sql: 'SELECT COUNT(*) FROM order_lines WHERE order_id = ?',
                args: [targetOrderId],
              }) as { rows?: unknown[][] };
              const finalLineCount = Number(verifyLines.rows?.[0]?.[0] ?? 0);
              if (finalLineCount === 0) {
                if (!existingOrderBeforeId) {
                  await rawClient.execute({
                    sql: 'DELETE FROM orders WHERE id = ?',
                    args: [targetOrderId],
                  });
                }
                await withRetry(
                  () => rawClient.execute({
                    sql: `UPDATE stripe_order_import_staging
                          SET status='failed', last_error='integrity_check_no_lines', attempts=?, updated_at=datetime('now')
                          WHERE id=?`,
                    args: [staged.attempts + 1, staged.id],
                  }),
                  10,
                  200,
                );
                orderStats.failed++;
                continue;
              }
            }

            if (!existingOrderBeforeId && targetOrderId) {
              orderStats.finalized++;
            } else {
              orderStats.skipped++;
              orderSkipReasons.alreadyImported++;
            }

            await withRetry(
              () => rawClient.execute({
                sql: `UPDATE stripe_order_import_staging
                      SET status='finalized', last_error=NULL, attempts=?, updated_at=datetime('now')
                      WHERE id=?`,
                args: [staged.attempts + 1, staged.id],
              }),
              10,
              200,
            );

            // Step 16: Block duplicate webhook fulfillment for admin-synced orders
            await withRetry(
              () => rawClient.execute({
                sql: `INSERT INTO processed_webhook_events (stripe_event_id, processed_at)
                      VALUES (?, datetime('now'))
                      ON CONFLICT(stripe_event_id) DO NOTHING`,
                args: [`admin-sync:${staged.stripePaymentIntentId}`],
              }),
              10,
              200,
            );
          } catch (stageErr) {
            const formatted = formatError(stageErr);
            orderStats.failed++;
            orderSkipReasons.processingError++;
            orderProcessingErrors[formatted] = (orderProcessingErrors[formatted] ?? 0) + 1;

            await withRetry(
              () => rawClient.execute({
                sql: `UPDATE stripe_order_import_staging
                      SET status='failed', last_error=?, attempts=?, updated_at=datetime('now')
                      WHERE id=?`,
                args: [formatted, staged.attempts + 1, staged.id],
              }),
              10,
              200,
            );
          }
        }
      }

      const stagingStatuses = await db
        .select({ status: stripeOrderImportStaging.status, claimedAt: stripeOrderImportStaging.claimedAt })
        .from(stripeOrderImportStaging);
      const nowMs = Date.now();
      const fiveMinMs = 5 * 60 * 1000;
      const backlog = { pending: 0, failed: 0, finalized: 0, staleProcessing: 0 };
      for (const row of stagingStatuses) {
        if (row.status === 'pending') backlog.pending++;
        else if (row.status === 'failed') backlog.failed++;
        else if (row.status === 'finalized') backlog.finalized++;
        else if (row.status === 'processing') {
          const claimedMs = row.claimedAt ? new Date(row.claimedAt).getTime() : 0;
          if (nowMs - claimedMs > fiveMinMs) backlog.staleProcessing++;
        }
      }

      return ok({
        phase,
        controls: {
          finalizeBatch,
          cursorPersisted: Boolean(lastProcessedChargeId),
        },
        products: productStats,
        customers: customerStats,
        orders: {
          ...orderStats,
          backlog,
          remainingToFinalize: backlog.pending + backlog.failed + backlog.staleProcessing,
          debug: {
            skipReasons: orderSkipReasons,
            processingErrors: orderProcessingErrors,
          },
        },
      });
    } catch (err) {
      console.error('[admin-sync] Order import error:', err);
      return serverError('Order import from Stripe failed');
    }
  },
});
