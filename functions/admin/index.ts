/**
 * Admin Worker entry point.
 * Deployed separately from the main API Worker.
 * All routes require role = 'admin' (enforced per handler).
 */
import type { AppEnv } from '../../src/types.js';
import { validateBearerToken } from '../../src/middleware/auth.js';
import { forbidden, unauthorized } from '../../src/types.js';
import { handleDashboard } from './dashboard.js';
import { handleSalesReport, handleInventoryReport, handleCustomersReport } from './reports.js';

// Simple pattern-match router for admin routes
type Handler = (request: Request, env: AppEnv) => Promise<Response>;

const routes: Array<{ method: string; pathname: string; handler: Handler }> = [
  { method: 'GET', pathname: '/admin/dashboard',          handler: handleDashboard },
  { method: 'GET', pathname: '/admin/reports/sales',      handler: handleSalesReport },
  { method: 'GET', pathname: '/admin/reports/inventory',  handler: handleInventoryReport },
  { method: 'GET', pathname: '/admin/reports/customers',  handler: handleCustomersReport },
];

async function handleRequest(request: Request, env: AppEnv): Promise<Response> {
  // Auth enforcement: must be admin
  const payload = await validateBearerToken(request, env);
  if (!payload) return unauthorized();
  if (payload.role !== 'admin') return forbidden();

  const url = new URL(request.url);
  const route = routes.find(r => r.method === request.method && r.pathname === url.pathname);
  if (!route) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });

  return route.handler(request, env);
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 });
    }
  },
};
