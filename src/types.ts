/**
 * Shared TypeScript interfaces used across all modules.
 */

// ---- Environment bindings ---------------------------------------------------

/**
 * AppEnv is passed to every handler.
 * On Cloudflare Workers, this is the `env` bindings object.
 * On Vercel, it is constructed from process.env in the platform shim.
 */
export interface AppEnv {
  ENVIRONMENT: 'development' | 'staging' | 'production';
  /** 'local' uses a SQLite file (local.sqlite); 'turso' uses the remote Turso instance. Defaults to 'turso'. */
  DB_SRC?: 'local' | 'turso';
  TURSO_DB_URL: string;
  TURSO_AUTH_TOKEN: string;
  JWT_PUBLIC_KEY: string;
  JWT_PRIVATE_KEY: string;
  ALLOWED_ORIGINS: string;
  /** One-time admin bootstrap secret. Remove after first admin is created. */
  BOOTSTRAP_SECRET?: string;
  /** CF Workers Rate Limiting binding — injected by the runtime, absent on Vercel/local. */
  RATE_LIMITER_PUBLIC?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  RATE_LIMITER_AUTH?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  /** Stripe secret key (sk_live_* or sk_test_*). */
  STRIPE_SECRET_KEY: string;
  /** Stripe webhook signing secret (whsec_*). */
  STRIPE_WEBHOOK_SECRET: string;
  /** Stripe publishable key (pk_live_* or pk_test_*). Optional — only needed if returned to clients. */
  STRIPE_PUBLISHABLE_KEY?: string;
}

// ---- Request context --------------------------------------------------------

/**
 * RequestContext is created per request and threaded through middleware and handlers.
 */
export interface RequestContext {
  env: AppEnv;
  /** Set by auth middleware after JWT validation. */
  userId?: string;
  /** Set by auth middleware after JWT validation. */
  role?: 'customer' | 'admin';
}

// ---- Response shapes --------------------------------------------------------

export interface ApiResponse<T> {
  data: T | null;
  meta?: PaginationMeta;
  error: ApiError | null;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
}

export interface ApiError {
  code: string;
  message: string;
}

// ---- Route definition -------------------------------------------------------

export type AuthRequirement = 'none' | 'customer' | 'admin';

export interface RouteDefinition {
  method: string;
  path: string;
  auth: AuthRequirement;
  description: string;
  queryParams?: string[];
  handler: (request: Request, ctx: RequestContext, params: Record<string, string>) => Promise<Response>;
}

// ---- Pagination helpers -----------------------------------------------------

export interface PaginationParams {
  page: number;
  pageSize: number;
  offset: number;
}

export function parsePagination(url: URL, defaultPageSize = 20): PaginationParams {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? String(defaultPageSize))));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// ---- Response helpers -------------------------------------------------------

export function ok<T>(data: T, meta?: PaginationMeta): Response {
  return Response.json({ data, meta: meta ?? null, error: null } satisfies ApiResponse<T>, { status: 200 });
}

export function created<T>(data: T): Response {
  return Response.json({ data, meta: null, error: null } satisfies ApiResponse<T>, { status: 201 });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function badRequest(message: string, code = 'BAD_REQUEST'): Response {
  return Response.json({ data: null, meta: null, error: { code, message } } satisfies ApiResponse<null>, { status: 400 });
}

export function unauthorized(message = 'Authentication required'): Response {
  return Response.json({ data: null, meta: null, error: { code: 'UNAUTHORIZED', message } } satisfies ApiResponse<null>, { status: 401 });
}

export function forbidden(message = 'Insufficient permissions'): Response {
  return Response.json({ data: null, meta: null, error: { code: 'FORBIDDEN', message } } satisfies ApiResponse<null>, { status: 403 });
}

export function notFound(message = 'Resource not found'): Response {
  return Response.json({ data: null, meta: null, error: { code: 'NOT_FOUND', message } } satisfies ApiResponse<null>, { status: 404 });
}

export function methodNotAllowed(message = 'Method not allowed'): Response {
  return Response.json({ data: null, meta: null, error: { code: 'METHOD_NOT_ALLOWED', message } } satisfies ApiResponse<null>, { status: 405 });
}

export function conflict(message: string): Response {
  return Response.json({ data: null, meta: null, error: { code: 'CONFLICT', message } } satisfies ApiResponse<null>, { status: 409 });
}

export function unprocessable(message: string, code = 'UNPROCESSABLE'): Response {
  return Response.json({ data: null, meta: null, error: { code, message } } satisfies ApiResponse<null>, { status: 422 });
}

export function serverError(message = 'Internal server error'): Response {
  return Response.json({ data: null, meta: null, error: { code: 'INTERNAL_ERROR', message } } satisfies ApiResponse<null>, { status: 500 });
}
