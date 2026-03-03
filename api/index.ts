/**
 * Vercel Edge Function catch-all entry point.
 * All requests are rewritten here via vercel.json.
 * Delegates to the shared platform handler in src/platforms/vercel.ts.
 */
export { default } from '../src/platforms/vercel.js';

export const config = { runtime: 'edge' };
