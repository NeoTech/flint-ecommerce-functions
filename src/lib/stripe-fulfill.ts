/**
 * Shared Stripe checkout fulfillment logic.
 *
 * Used by both the webhook handler (real-time) and the admin sync
 * (historical backfill). Idempotency is enforced via the
 * processed_webhook_events table — calling this twice with the same
 * eventId is safe.
 */
import { eq } from 'drizzle-orm';
import {
  addresses,
  customers,
  orderLines,
  orders,
  processedWebhookEvents,
  products,
  users,
} from '../db/schema.js';
import { getStripe } from './stripe.js';
import type { AppEnv } from '../types.js';
import type { getDb } from '../db/client.js';
import type Stripe from 'stripe';

export async function fulfillCheckoutSession(
  session: Stripe.Checkout.Session,
  eventId: string,
  env: AppEnv,
  db: ReturnType<typeof getDb>,
): Promise<boolean> {
  // Idempotency check: skip if this event has already been processed.
  const already = await db
    .select()
    .from(processedWebhookEvents)
    .where(eq(processedWebhookEvents.stripeEventId, eventId));

  if (already.length > 0) return false;

  const stripe = getStripe(env);

  // Fetch line items via the dedicated endpoint (avoids the 4-level deep expand
  // that times out on Cloudflare Workers — stripe/stripe-node#2493).
  const lineItemsPage = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 100,
    expand: ['data.price.product'],
  });

  if (!lineItemsPage || lineItemsPage.data.length === 0) return false;

  // Resolve the customer: find by email in local DB.
  const email = session.customer_details?.email ?? session.customer_email ?? null;

  let user = email
    ? (await db.select().from(users).where(eq(users.email, email)))[0]
    : undefined;

  if (!user && email) {
    // Guest checkout: create a local user + customer record.
    const userId = crypto.randomUUID();
    const name = session.customer_details?.name ?? '';
    const [firstName, ...rest] = name.split(' ');
    const lastName = rest.join(' ') || '-';

    await db.insert(users).values({
      id: userId,
      email,
      passwordHash: '', // Guest — no password set
      role: 'customer',
      stripeCustomerId: typeof session.customer === 'string' ? session.customer : null,
    });
    await db.insert(customers).values({
      id: crypto.randomUUID(),
      userId,
      firstName: firstName || email,
      lastName,
    });

    user = (await db.select().from(users).where(eq(users.id, userId)))[0];
  }

  if (!user) return false;

  // Backfill stripeCustomerId if missing.
  if (!user.stripeCustomerId && typeof session.customer === 'string') {
    await db.update(users)
      .set({ stripeCustomerId: session.customer })
      .where(eq(users.id, user.id));
  }

  // Resolve the customer row — create one if missing (e.g. admin user who placed a test order).
  let customerRow = (
    await db.select().from(customers).where(eq(customers.userId, user.id))
  )[0];

  if (!customerRow) {
    const custId = crypto.randomUUID();
    const name = session.customer_details?.name ?? '';
    const [firstName, ...rest] = name.split(' ');
    await db.insert(customers).values({
      id: custId,
      userId: user.id,
      firstName: firstName || user.email,
      lastName: rest.join(' ') || '-',
    });
    customerRow = (await db.select().from(customers).where(eq(customers.userId, user.id)))[0];
  }

  if (!customerRow) return false;

  // Upsert shipping address if provided.
  let shippingAddressId: string | null = null;
  const shippingAddr = session.shipping_details?.address ?? session.customer_details?.address;
  if (shippingAddr) {
    const addrId = crypto.randomUUID();
    await db.insert(addresses).values({
      id: addrId,
      customerId: customerRow.id,
      type: 'shipping',
      street: shippingAddr.line1 ?? '',
      city: shippingAddr.city ?? '',
      state: shippingAddr.state ?? null,
      postalCode: shippingAddr.postal_code ?? '',
      country: shippingAddr.country ?? 'US',
      isDefault: false,
    });
    shippingAddressId = addrId;
  }

  // Map Stripe line items to local products.
  const resolvedLines: {
    productId: string;
    unitPrice: number;
    quantity: number;
    stripePriceId: string | null;
  }[] = [];

  for (const item of lineItemsPage.data) {
    const priceObj = item.price as Stripe.Price | null;
    const stripeProductId =
      priceObj && typeof priceObj.product === 'string'
        ? priceObj.product
        : (priceObj?.product as Stripe.Product | null)?.id ?? null;

    if (!stripeProductId) continue;

    let productRows = await db
      .select()
      .from(products)
      .where(eq(products.stripeProductId, stripeProductId));

    if (productRows.length === 0) {
      // Product exists in Stripe but not locally — import it on the fly.
      // Use the expanded product name if available, otherwise fall back to the Stripe product ID.
      const expandedProduct = priceObj?.product as Stripe.Product | null;
      const productName = (expandedProduct && typeof expandedProduct === 'object' && expandedProduct.name)
        ? expandedProduct.name
        : stripeProductId;
      const productDesc = (expandedProduct && typeof expandedProduct === 'object')
        ? (expandedProduct.description ?? null)
        : null;
      const unitAmountFallback = (item.amount_total ?? 0) / 100 / (item.quantity ?? 1);

      // Build a unique slug.
      const baseSlug = productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      let slug = baseSlug;
      let suffix = 2;
      for (;;) {
        const existing = await db.select({ id: products.id }).from(products).where(eq(products.slug, slug));
        if (existing.length === 0) break;
        slug = `${baseSlug}-${suffix++}`;
      }

      try {
        await db.insert(products).values({
          name: productName,
          slug,
          description: productDesc,
          price: unitAmountFallback,
          stock: 0,
          status: 'active',
          stripeProductId,
          stripePriceId: priceObj?.id ?? null,
        });
      } catch (insertErr) {
        // Could be a race condition or constraint violation — try to find the row anyway.
        console.error(`[stripe-fulfill] Failed to auto-insert product ${stripeProductId}:`, insertErr);
      }

      productRows = await db.select().from(products).where(eq(products.stripeProductId, stripeProductId));
    }

    const product = productRows[0];
    if (!product) continue;

    const unitPrice = (item.amount_total ?? 0) / 100 / (item.quantity ?? 1);
    resolvedLines.push({
      productId: product.id,
      unitPrice,
      quantity: item.quantity ?? 1,
      stripePriceId: priceObj?.id ?? null,
    });
  }

  if (resolvedLines.length === 0) {
    console.error(`[stripe-fulfill] No resolvable line items for session ${session.id}. Line items count: ${lineItemsPage.data.length}. Product IDs attempted: ${lineItemsPage.data.map((i) => (i.price as { product?: unknown } | null)?.product ?? 'none').join(', ')}`);
    return false;
  }

  const subtotal = resolvedLines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const total = (session.amount_total ?? 0) / 100;

  await db.transaction(async (tx) => {
    const [order] = await tx
      .insert(orders)
      .values({
        customerId: customerRow.id,
        status: 'confirmed',
        subtotal,
        total,
        source: 'stripe',
        stripeSessionId: session.id,
        stripePaymentIntentId:
          typeof session.payment_intent === 'string' ? session.payment_intent : null,
        shippingAddressId,
      })
      .returning();

    await tx.insert(orderLines).values(
      resolvedLines.map((l) => ({
        orderId: order.id,
        productId: l.productId,
        variantId: null,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.unitPrice * l.quantity,
        stripePriceId: l.stripePriceId,
      })),
    );

    await tx.insert(processedWebhookEvents).values({ stripeEventId: eventId });
  });

  return true;
}
