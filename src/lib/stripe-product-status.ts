/**
 * Canonical Stripe product -> local product status mapping.
 *
 * This is the SINGLE source of truth for determining what local `products.status`
 * value a Stripe product should map to.  Every code path that creates or updates
 * a product from Stripe data MUST use this function.
 */
import type Stripe from 'stripe';

/**
 * Map a Stripe Product object to the local product status enum.
 *
 * - `active === true`  -> `'active'`
 * - `active === false` -> `'archived'`  (includes deleted products)
 * - Missing/undefined  -> `'archived'`  (defensive default — never silently activate)
 */
export function mapStripeProductStatus(
  stripeProduct: Pick<Stripe.Product, 'active'>,
): 'active' | 'archived' {
  return stripeProduct.active === true ? 'active' : 'archived';
}
