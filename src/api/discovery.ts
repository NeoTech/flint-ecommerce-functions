import { registerRoute } from '../router.js';
import { getRoutes } from '../router.js';
import { ok } from '../types.js';

registerRoute({
  method: 'GET',
  path: '/',
  auth: 'none',
  description: 'API discovery — returns all available routes and their metadata',
  handler: async (_request, ctx, _params) => {
    const routes = getRoutes();
    return ok({
      name: 'LOPC API',
      version: '1.0.0',
      environment: ctx.env.ENVIRONMENT,
      routes: routes.map(r => ({
        method:      r.method,
        path:        r.path,
        auth:        r.auth,
        description: r.description,
        queryParams: r.queryParams ?? [],
      })),
    });
  },
});
