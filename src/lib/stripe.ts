/**
 * Stripe client factory.
 *
 * Uses `Stripe.createFetchHttpClient()` so the SDK works inside
 * Cloudflare Workers (no Node.js `http` module required).
 *
 * The client is cached per environment object so it is only instantiated
 * once per isolate lifetime; the cache is keyed by the secret key string
 * so that test environments with different keys each get their own instance.
 */
import Stripe from 'stripe';
import type { AppEnv } from '../types.js';

const _cache = new Map<string, Stripe>();

export function getStripe(env: AppEnv): Stripe {
  const key = env.STRIPE_SECRET_KEY;
  if (!_cache.has(key)) {
    _cache.set(
      key,
      new Stripe(key, {
        // Required for CF Workers — avoids Node.js built-in http module.
        httpClient: Stripe.createFetchHttpClient(),
        // Pin API version so SDK types are accurate.
        apiVersion: '2026-02-25.clover',
      }),
    );
  }
  return _cache.get(key)!;
}
