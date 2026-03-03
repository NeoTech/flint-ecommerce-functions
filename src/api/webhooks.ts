/**
 * Stripe Webhook handler.
 *
 * POST /webhooks/stripe
 *
 * Listens for Stripe events and fulfills orders on checkout completion.
 * Uses idempotency via the processed_webhook_events table so that Stripe
 * retries never create duplicate orders.
 *
 * CF Workers note: uses constructEventAsync (NOT constructEvent) because the
 * synchronous version requires Node.js crypto internals that are not available
 * in the CF Workers runtime.
 */
import { registerRoute } from '../router.js';
import { getDb } from '../db/client.js';
import { getStripe } from '../lib/stripe.js';
import { fulfillCheckoutSession } from '../lib/stripe-fulfill.js';
import { badRequest, ok } from '../types.js';
import type Stripe from 'stripe';

// ---- POST /webhooks/stripe --------------------------------------------------

registerRoute({
  method: 'POST',
  path: '/webhooks/stripe',
  auth: 'none',
  description: 'Receives and processes Stripe webhook events.',
  handler: async (request, ctx) => {
    // Must read raw body BEFORE any JSON parsing.
    const rawBody = Buffer.from(await request.arrayBuffer());
    const sig = request.headers.get('stripe-signature');

    if (!sig) {
      return badRequest('Missing stripe-signature header');
    }

    const stripe = getStripe(ctx.env);

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(
        rawBody,
        sig,
        ctx.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Signature verification failed';
      return badRequest(`Webhook signature verification failed: ${message}`);
    }

    // Only handle checkout session events.
    const HANDLED_EVENTS = [
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
    ] as const;

    if (HANDLED_EVENTS.includes(event.type as typeof HANDLED_EVENTS[number])) {
      const session = event.data.object as Stripe.Checkout.Session;

      // Only fulfill when payment is captured (not 'unpaid' = pending async payment).
      if (session.payment_status !== 'unpaid') {
        const db = getDb(ctx.env);
        await fulfillCheckoutSession(session, event.id, ctx.env, db);
      }
    }

    return ok({ received: true });
  },
});
