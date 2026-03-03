/**
 * URL Pattern API router.
 *
 * Routes are registered with full metadata (method, path, auth, description)
 * so the discovery endpoint can generate a manifest at runtime without any
 * separate spec file.
 *
 * API modules call registerRoute() during module initialisation.
 * The platform entry points call dispatch() for every incoming request.
 */
import type { AppEnv, AuthRequirement, RequestContext, RouteDefinition } from './types.js';
import { forbidden, methodNotAllowed, notFound, serverError, unauthorized } from './types.js';

// ---- Route registry ---------------------------------------------------------

const registry: RouteDefinition[] = [];

/**
 * Register a route. Called by each api/* module at import time.
 */
export function registerRoute(def: RouteDefinition): void {
  registry.push(def);
}

/**
 * Return the full route registry. Used by the discovery handler.
 */
export function getRoutes(): ReadonlyArray<Omit<RouteDefinition, 'handler'>> {
  return registry.map(({ handler: _handler, ...meta }) => meta);
}

// ---- Dispatcher -------------------------------------------------------------

/**
 * Match an incoming request against the registry and invoke the handler
 * after running the middleware chain (CORS → rate-limit → auth).
 */
export async function dispatch(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);

  // Handle CORS preflight before any other processing.
  if (request.method === 'OPTIONS') {
    return handlePreflight(request, env);
  }

  // Find the first matching route. Distinguishes 404 (path unknown) from 405 (path known, wrong method).
  const match = findRoute(request.method, url);

  if (match === null) {
    return addCorsHeaders(notFound('No route matched this path'), request, env);
  }

  if (match === 'method_not_allowed') {
    return addCorsHeaders(methodNotAllowed(), request, env);
  }

  const ctx: RequestContext = { env };

  // Rate limiting — tier depends on whether the route requires auth.
  const tier = match.route.auth === 'none' ? 'public' : 'auth';
  const { checkRateLimit } = await import('./middleware/ratelimit.js');
  const rateLimitResponse = await checkRateLimit(request, env, tier);
  if (rateLimitResponse) {
    return addCorsHeaders(rateLimitResponse, request, env);
  }

  // Auth middleware — runs for routes requiring authentication.
  if (match.route.auth !== 'none') {
    const authResult = await runAuthMiddleware(request, ctx, match.route.auth);
    if (authResult) {
      return addCorsHeaders(authResult, request, env);
    }
  }

  // Invoke the route handler.
  try {
    const response = await match.route.handler(request, ctx, match.params);
    return addCorsHeaders(response, request, env);
  } catch (err) {
    console.error('[router] Unhandled error:', err);
    return addCorsHeaders(serverError(), request, env);
  }
}

// ---- Internal helpers -------------------------------------------------------

interface RouteMatch {
  route: RouteDefinition;
  params: Record<string, string>;
}

function findRoute(method: string, url: URL): RouteMatch | 'method_not_allowed' | null {
  let pathMatched = false;

  for (const route of registry) {
    const pattern = new URLPattern({ pathname: route.path });
    const result = pattern.exec(url);
    if (!result) continue;

    pathMatched = true;

    if (route.method !== method && route.method !== '*') continue;

    const params = Object.fromEntries(
      Object.entries(result.pathname.groups).filter(([, v]) => v !== undefined) as [string, string][],
    );
    return { route, params };
  }

  return pathMatched ? 'method_not_allowed' : null;
}

async function runAuthMiddleware(
  request: Request,
  ctx: RequestContext,
  required: AuthRequirement,
): Promise<Response | null> {
  // Lazy-import to avoid circular dependency; auth module uses types from this file.
  const { validateBearerToken } = await import('./middleware/auth.js');
  const result = await validateBearerToken(request, ctx.env);

  if (!result) {
    return unauthorized();
  }

  ctx.userId = result.userId;
  ctx.role = result.role;

  if (required === 'admin' && result.role !== 'admin') {
    return forbidden();
  }

  return null;
}

function handlePreflight(request: Request, env: AppEnv): Response {
  const response = new Response(null, { status: 204 });
  return addCorsHeaders(response, request, env);
}

function addCorsHeaders(response: Response, request: Request, env: AppEnv): Response {
  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : ['*'];

  const origin = request.headers.get('Origin') ?? '';
  const wildcardAllowed = allowedOrigins.includes('*');
  const originAllowed = wildcardAllowed || !origin || allowedOrigins.includes(origin);

  // Reject browser requests from unlisted origins
  if (origin && !originAllowed) {
    return new Response(JSON.stringify({ data: null, meta: null, error: { code: 'FORBIDDEN', message: 'Origin not allowed' } }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const headers = new Headers(response.headers);
  if (origin && originAllowed) headers.set('Access-Control-Allow-Origin', wildcardAllowed ? '*' : origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'interest-cohort=()');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
