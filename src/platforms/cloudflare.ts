/**
 * Cloudflare Workers entry point.
 *
 * Exports the standard Workers fetch handler.
 * All routing and middleware is handled by src/router.ts.
 */
import '../app.js';
import { dispatch } from '../router.js';
import type { AppEnv } from '../types.js';

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    return dispatch(request, env);
  },
} satisfies ExportedHandler<AppEnv>;
