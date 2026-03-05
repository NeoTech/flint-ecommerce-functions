# Logistic-Orders-Products-Customers (LOPC) Project - Task Tracking

## LOPC-01: Plan and detail tasks fo the project.
### Goals: Create a detailed plan for the LOPC project, breaking down the work into manageable tasks and subtasks. LOPC is a serverless application that provides an API for managing logistics, orders, products, and customers. The project will be built using Typscript using Bun/Bunx and deployed on a serverless platform like Cloudflare Workers or Vercel / Netlify.
**Notes:** Research existing ecommerce platforms like shopify, woocommerce, bigcommerce to understand common features and API design patterns. Consider using a serverless database like FaunaDB or DynamoDB for data storage. Focus on creating a clean and intuitive API design that follows RESTful principles. The whole system should be designed to be consumed as a backend for a headless ecommerce frontend, so consider the needs of frontend developers when designing the API. Also all reporting and administration tools should be built as separate serverless functions that can be deployed independently and integrated into a dashboard or a standalone frontend.
In the codebase a prexisting deploy strategy is already in place for Cloudflare Workers, but the code should be written in a way that allows for easy deployment to other serverless platforms if needed. Same functions should be deployable to multiple platforms with minimal changes. The project should be designed with scalability in mind, allowing for easy addition of new features and functionality in the future. The project should also include comprehensive documentation for both the API and the deployment process, making it easy for other developers to understand and contribute to the project. The project should be structured in a way that allows for easy testing and debugging, with clear separation of concerns and modular code design. Finally, the project should be designed to be secure, with proper authentication and authorization mechanisms in place to protect sensitive data and prevent unauthorized access.
The project should have a discovery application that allows the user to get all the API endpoints for easy integration into a frontend or consumed into a dashboard. This discovery application should be a simple serverless function that returns a JSON object with all the available API endpoints, their methods, and a brief description of their functionality. This will make it easy for frontend developers to understand how to interact with the API and integrate it into their applications.
- [x] LOPC-01-1: Research and select a serverless platform (Cloudflare Workers, Vercel, Netlify) based on project requirements and constraints. Document the pros and cons of each platform in `.docs/research.md`.
- [x] LOPC-01-2: Architecture defined — modular single-file handlers per domain, URL Pattern API router with route metadata, thin platform shims (CF + Vercel), admin Worker deployed independently. See LOPC-02 for scaffold story, docs/research.md for full diagram.
- [x] LOPC-01-3: Full implementation task breakdown created — Phases 0–9, stories LOPC-02 through LOPC-12 with checkable subtasks appended to this file.
- [x] LOPC-01-4: Priority and timeline defined — 4 milestones: M1 Scaffold+DB+Auth, M2 Products+Orders+Customers, M3 Logistics+Admin+Discovery, M4 CI/CD+Docs+Hardening. See LOPC-02 through LOPC-12.
- [x] LOPC-01-5: API design complete — 35 endpoints across 7 domains (Auth, Products, Categories, Customers, Orders, Logistics, Admin), standard response envelope, JWT RS256 auth, role-based access. Full breakdown in LOPC-05 through LOPC-10.
- [x] LOPC-01-6: Database selected — **Turso (LibSQL/SQLite)** as primary store, **Upstash Redis** for caching and rate-limiting. Turso: 500M reads/month free, works natively across CF Workers + Vercel via HTTP driver, same Drizzle ORM as D1. FaunaDB dead, PlanetScale has no free tier. Full research in docs/research.md.
- [x] LOPC-01-7: Discovery app designed — `GET /` returns a runtime-generated JSON manifest from router metadata. No separate spec file to maintain. Auto-generates OpenAPI-compatible route list. Implemented in LOPC-10.
- [x] LOPC-01-8: CI/CD designed — two GitHub Actions workflows: `deploy-cloudflare.yml` (Wrangler) and `deploy-vercel.yml`. `main` → production, PRs → Vercel preview URLs. Secrets documented in LOPC-11.
- [x] LOPC-01-9: Documentation plan — README, OpenAPI 3.1 spec auto-generated from discovery module, JSDoc on all handlers, `docs/schema.md`. Implemented in LOPC-11.
- [x] LOPC-01-10: Security plan — JWT RS256 via `jose`, refresh token rotation (Upstash blacklist), bcrypt via `Bun.password`, RBAC middleware, `@upstash/ratelimit` per IP, `zod` on all request bodies, CORS allowlist. Implemented in LOPC-04 and LOPC-11.
- [x] LOPC-01-11: Scalability design — CF Workers auto-scale at edge, Turso global read replicas, Redis cache for hot product listings, admin Worker isolated, SQLite write headroom ~1k orders/day before needing Neon+Hyperdrive upgrade. New domains = new file in src/api/ only.
- [x] LOPC-01-12: Testing strategy — Bun test runner, co-located `.test.ts` per handler, Turso test DB for integration, `wrangler dev` + fetch for E2E, 80% coverage target. Full breakdown in LOPC-12.

---

## LOPC-02: Phase 0 — Project Scaffold

**Goal:** Initialize a working Bun/TypeScript project with all tooling, config files, and directory structure in place. No business logic yet — just a green `bun run dev` and a passing `bun run test`.

**Notes:** The project has no `package.json` yet. Deployment targets are Cloudflare Workers (primary) and Vercel (secondary). Bun is the runtime for local dev, test, and build. Wrangler bundles for CF production. Biome for lint/format — no ESLint. The handler export shape (`export default { fetch }`) must be the same across CF and Vercel entry points.

- [x] LOPC-02-1: `package.json` created — all scripts, runtime deps (@libsql/client, drizzle-orm, jose, zod, upstash), devDeps (wrangler, biome, ts, drizzle-kit)
- [x] LOPC-02-2: `tsconfig.json` — ESNext, bundler moduleResolution, strict, DOM lib, @cloudflare/workers-types
- [x] LOPC-02-3: `biome.json` — lint + format, single quotes, trailing commas, noUnusedImports as error
- [x] LOPC-02-4: `wrangler.toml` — entry `src/platforms/cloudflare.ts`, compatibility_date 2025-09-01, nodejs_compat flag, commented D1/KV binding placeholders, staging + production envs
- [x] LOPC-02-5: `vercel.json` — edge runtime, catch-all rewrite to `api/index.ts`, bun install/build commands
- [x] LOPC-02-6: Directory structure created: `src/api/`, `src/db/`, `src/middleware/`, `src/platforms/`, `functions/admin/`, `api/` (Vercel catch-all), `.env.example`, `.env.test.example`
- [x] LOPC-02-7: `src/platforms/cloudflare.ts` and `src/platforms/vercel.ts` — both wire `dispatch()` from router; Vercel shim builds `AppEnv` from `process.env`
- [x] LOPC-02-8: `src/router.ts` — full stub: `registerRoute`, `getRoutes`, `dispatch`, URL Pattern matching, CORS headers, security headers, auth middleware hook, error handling. `src/types.ts` — all shared interfaces + response helpers. `src/middleware/auth.ts` + `cors.ts` + `ratelimit.ts` stubs.
- [x] LOPC-02-9: `bun run dev` (wrangler dev) — entry point resolves correctly
- [x] LOPC-02-10: `bun test` — 24 tests pass across 2 files (3 new router scaffold tests + 21 pre-existing deploy tests)

---

## LOPC-03: Phase 1 — Database Setup

**Goal:** Turso database provisioned, Drizzle schema written, migrations applied, client factory implemented, and seed data available for local development.

**Notes:** Use `@libsql/client` HTTP driver — works in CF Workers, Vercel Edge, and local Bun. Drizzle ORM for type-safe queries and migrations. All DB access goes through `src/db/client.ts` so switching to D1 later is a one-file change. Store `TURSO_DB_URL` and `TURSO_AUTH_TOKEN` in a `.env` file for local dev and in platform secrets for deployment. Never commit the `.env` file.

- [x] LOPC-03-1: Create Turso account at turso.tech, provision database named `lopc-prod`, note connection URL and auth token in .env
- [x] LOPC-03-2: Dependencies already installed in LOPC-02 (`@libsql/client`, `drizzle-orm`, `drizzle-kit`)
- [x] LOPC-03-3: Add `TURSO_DB_URL` and `TURSO_AUTH_TOKEN` to `.env` (ensure `.env` is in `.gitignore`)
- [x] LOPC-03-4: `src/db/schema.ts` — 9 Drizzle table definitions with UUIDs, FK relations, enums, and datetime defaults
- [x] LOPC-03-5: `drizzle.config.ts` — Turso dialect, reads credentials from `.env` synchronously
- [x] LOPC-03-6: Migration generated → `src/db/migrations/0000_marvelous_madripoor.sql` (9 tables, 1 index each)
- [x] LOPC-03-7: Migration applied — `migrations applied successfully!`
- [x] LOPC-03-8: `src/db/client.ts` — `getDb(env)` factory via `@libsql/client/http`, re-exports schema types
- [x] LOPC-03-9: `src/db/seed.ts` — seeds 2 categories, 2 products, 3 variants, 1 customer, 1 address, 1 order; idempotent
- [x] LOPC-03-10: `src/db/client.test.ts` — SELECT 1 connectivity + all 9 tables present; 5/5 tests passing

---

## LOPC-04: Phase 2 — Router, Middleware, and Platform Shims

**Goal:** A working request pipeline: incoming request → CORS → rate-limit → auth (if required) → route handler → response. Both platform entry points wire to the same router.

**Notes:** Use the URL Pattern API (`new URLPattern(...)`) — native in CF Workers and Vercel Edge, polyfilled for local Bun via `urlpattern-polyfill`. Route registration objects carry metadata (method, path, auth requirement, description, queryParams) — this metadata powers the discovery endpoint in LOPC-10. JWT validation uses `jose` — the only library that works across all edge runtimes with no Node.js globals. Upstash Redis rate-limiting uses `@upstash/ratelimit` with its REST SDK.

- [x] LOPC-04-1: Dependencies already installed in LOPC-02 (`jose`, `@upstash/redis`, `@upstash/ratelimit`, `zod`, `urlpattern-polyfill`)
- [x] LOPC-04-2: Upstash Redis env vars already in `.env.example` and `.env.test.example`
- [x] LOPC-04-3: `src/router.ts` complete: `RouteDefinition`, `registerRoute`, `getRoutes`, `dispatch` with 404/405 detection and rate-limit + auth middleware chain
- [x] LOPC-04-4: `src/middleware/cors.ts` complete — CORS headers + OPTIONS preflight built into `dispatch`
- [x] LOPC-04-5: `src/middleware/auth.ts` — RS256 JWT validation via `jose`; reads `sub`/`userId` + `role` claims; fails closed on all errors
- [x] LOPC-04-6: `src/middleware/ratelimit.ts` — sliding window via `@upstash/ratelimit`; 100/min public, 30/min auth; fails open when Upstash is unreachable
- [x] LOPC-04-7: `src/types.ts` complete — `AppEnv`, `RequestContext`, `ApiResponse<T>`, `ApiError`, `PaginationMeta`, all response helpers including `methodNotAllowed`
- [x] LOPC-04-8: `src/platforms/cloudflare.ts` complete — CF `export default { fetch }` wired to `dispatch`
- [x] LOPC-04-9: `src/platforms/vercel.ts` complete — Vercel Edge function wired to `dispatch` with `process.env` shim
- [x] LOPC-04-10: `src/router.test.ts` — 9 tests: registry helpers, 200/404/405/OPTIONS/CORS/401; all passing
- [x] LOPC-04-11: `src/middleware/auth.test.ts` — 11 tests: missing header, non-Bearer, empty key, malformed, expired, no role, bad role, valid customer, valid admin, sub-only, wrong key; all passing

**Review**
All 22 tests pass (9 router, 11 auth, 2 db). Router now returns 405 on method mismatch. Rate limiter wired into dispatch (fails open when Upstash not configured). `scripts/gen-keys.ts` added for RS256 key pair generation.

---

## LOPC-05: Phase 3 — Auth API

**Goal:** Full authentication flow: register, login, logout, refresh, password reset. JWT access+refresh token pair issued on login. Refresh token stored in the DB (`refresh_tokens` table) with rotation on use.

**Notes:** `Bun.password.hash()` / `Bun.password.verify()` for bcrypt. Access token: RS256 JWT, 15min TTL, contains `userId` and `role`. Refresh token: opaque random string (32 bytes hex), SHA-256 hashed before storage, 7 days TTL — stored in `refresh_tokens` table. On refresh: old row deleted, new row inserted. Password reset token: separate opaque token, 1h TTL, stored in `refresh_tokens` with a `purpose='reset'` distinction (or a separate column). Zod validates all request bodies.

- [x] LOPC-05-1: Generate RS256 key pair (`bun scripts/gen-keys.ts`), document how to add `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` to env
- [x] LOPC-05-2: Write `src/api/auth.ts` — register all auth routes via `registerRoute`:
  - `POST /auth/register` — validate body (email, password, firstName, lastName), check email uniqueness, hash password, insert `users` + `customers` rows, return token pair
  - `POST /auth/login` — find user by email, verify password, return token pair
  - `POST /auth/logout` — delete refresh token row from DB
  - `POST /auth/refresh` — look up token hash in `refresh_tokens`, check expiry, issue new access token + rotate refresh token
  - `POST /auth/forgot-password` — generate reset token, store hashed in `refresh_tokens` (1h TTL), return `{ message: "If the email exists, a reset link has been sent" }` (no enumeration)
  - `POST /auth/reset-password` — validate reset token hash, hash new password, update `users.password_hash`, delete token row
- [x] LOPC-05-3: Write `src/lib/tokens.ts` — `issueTokenPair`, `rotateRefreshToken`, `revokeRefreshToken`, `issueResetToken`, `consumeResetToken`, `issueAccessToken`
- [x] LOPC-05-4: Write `src/api/auth.test.ts` — 18 tests covering: successful register, duplicate email rejection, wrong password, logout (idempotent), refresh rotation, expired token rejection, forgot-password no-enumeration, reset token single-use

**Review**
All 40 tests pass (18 auth, 9 router, 11 auth-middleware, 2 db). Full token pair lifecycle implemented with RS256 access tokens (15min), opaque refresh tokens (7d), and opaque reset tokens (1h) stored hashed in `refresh_tokens` table. Timing-safe login prevents email enumeration. Forgot-password returns identical 200 regardless of email existence. CF native rate limiting bindings in place (fails open locally). `src/app.ts` aggregates route imports; both platform shims wire through it.

---

## LOPC-06: Phase 4 — Products and Categories API

**Goal:** Full CRUD for products and categories, with pagination, filtering and variant management. Public read access; admin-only writes.

**Notes:** Products have a `status` field: `draft | active | archived`. Only `active` products appear in public listing. Soft-delete sets `status = archived`. `compare_price` is optional original price for showing discounts. Variants inherit product price if no variant price set. Category tree is returned as a nested JSON structure. `slug` fields are unique, URL-safe, auto-generated from `name` if not provided. Zod validates all write bodies.

- [x] LOPC-06-1: Write `src/api/products.ts` — 8 routes: list/get/create/update/soft-delete + variant list/add/update
- [x] LOPC-06-2: Write `src/api/categories.ts` — 5 routes: list/get-with-children/create/update/hard-delete (guarded by active products)
- [x] LOPC-06-3: Zod schemas defined inline in each handler file
- [x] LOPC-06-4: Write `src/api/products.test.ts` — 19 tests
- [x] LOPC-06-5: Write `src/api/categories.test.ts` — 13 tests

**Review**
72 tests pass (19 products + 13 categories + 40 existing). Slug auto-generated from name; non-admin requests always see only active products; soft-delete archives; category delete guarded by 409 if active products exist. Zod inline in handlers (no separate schemas dir).

---

## LOPC-07: Phase 5 — Customers API

**Goal:** Customer profile management and address book. Customers can read/edit their own data; admins can access all customers.

**Notes:** Customer data is split across `users` (auth fields) and `customers` (profile fields). The `GET /customers/:id` response merges both. Deleting a customer deactivates the account (`users.role = 'inactive'`) — does not hard-delete due to order history FK constraints. Address book supports multiple addresses; `is_default` flag per address type (shipping/billing).

- [x] LOPC-07-1: Write `src/api/customers.ts` — 9 routes (list, get, update, deactivate, orders, addresses CRUD)
- [x] LOPC-07-2: Zod schemas inline in customers.ts
- [x] LOPC-07-3: Write `src/api/customers.test.ts` — 28 tests

**Review**
100 tests pass (28 new). Self/admin enforcement on all personal data routes. Deactivation sets role='inactive' (no hard-delete). Address isDefault unsets prior default of same type on set. lineCount included on orders list.

---

## LOPC-08: Phase 6 — Orders API

**Goal:** Order lifecycle management from creation through delivery and refunds. Inventory reserved on order creation.

**Notes:** Order creation must be transactional: insert order + order_lines + decrement product/variant stock atomically (Turso/LibSQL supports transactions). Order status transitions are strictly enforced — invalid transitions return 422. Cancellation is allowed by the owner only within 30 minutes of creation; admins can cancel any time before `shipped`. Refund records a `refunded_amount` on the order row; full logic for actual payment refund is out of scope (stub returning success). Zod validates all write bodies.

- [x] LOPC-08-1: Write `src/api/orders.ts` — 6 routes (list, get, create with transaction, status transition, cancel with stock restore, refund)
- [x] LOPC-08-2: Write `src/lib/inventory.ts` — `reserveStock` / `releaseStock`
- [x] LOPC-08-3: Zod schemas inline in orders.ts
- [x] LOPC-08-4: Write `src/api/orders.test.ts` — 11 tests

**Review**
111 tests pass (11 new). Order creation runs in a DB transaction (insert order + lines + decrement stock atomically). Status transitions strictly enforced with 422 on invalid. Owner cancellation window: 30min + status=pending only. Refund auto-sets status=refunded on full refund.

---

## LOPC-09: Phase 7 — Logistics API

**Goal:** Shipment record management linked to orders, with a public tracking lookup endpoint.

**Notes:** Shipments are created by admins after an order reaches `processing` or `shipped` status. A single order may have multiple shipment records (partial fulfilment). The public `GET /logistics/tracking/:trackingNumber` endpoint looks up internal shipment status only — no external carrier API integration in scope (return internal status + carrier name). Return 404 if tracking number not found (do not reveal whether the number exists in the system for security).

- [x] LOPC-09-1: Write `src/api/logistics.ts` — 5 routes (admin list/get, create/update shipments, public tracking)
- [x] LOPC-09-2: Zod schemas inline in logistics.ts
- [x] LOPC-09-3: Write `src/api/logistics.test.ts` — 9 tests

**Review**
120 tests pass (9 new). Shipment creation auto-advances order to 'shipped'. Status update to 'delivered' auto-advances order. Public tracking endpoint exposes only carrier/status/shippedAt/deliveredAt (no internal IDs). Ownership check traverses shipment→order→customer→userId.

---

## LOPC-10: Phase 8 — Discovery Endpoint and Admin Worker

**Goal:** A runtime-generated route manifest at `GET /` and a separately deployed admin Worker with dashboard and reporting endpoints.

**Notes:** The discovery handler reads `getRoutes()` from `src/router.ts` at request time — no static file. The Admin Worker lives in `functions/admin/` and has its own `wrangler.toml`. It connects to the same Turso database but is deployed as a distinct Worker. Admin endpoints are protected by the same JWT auth middleware but require `role = admin`. Aggregate queries use Drizzle's `sql` template for groupBy and sum operations.

- [x] LOPC-10-1: Write `src/api/discovery.ts` — `GET /` returns runtime-generated manifest from getRoutes()
- [x] LOPC-10-2: Write `functions/admin/index.ts` — separate CF Worker entry point with JWT admin enforcement
- [x] LOPC-10-3: Write `functions/admin/dashboard.ts` — ordersToday, revenueToday, newCustomersToday, lowStockProducts
- [x] LOPC-10-4: Write `functions/admin/reports.ts` — sales (date range), inventory (products+variants), customers (acquisition)
- [x] LOPC-10-5: Create `functions/admin/wrangler.toml` — name='lopc-admin', same Turso env bindings
- [x] LOPC-10-6: Write `src/api/discovery.test.ts` — 4 tests (manifest shape, required routes present, no duplicates)
- [x] LOPC-10-7: Write `functions/admin/reports.test.ts` — 8 tests (sales filtering, exclusion of cancelled, inventory with variants, customer counts, dashboard shape)

**Review**
130 tests pass (4 + 8 new). Discovery reads live route registry at request time. Admin Worker deployed separately from main API. All admin routes enforce role=admin via validateBearerToken. Generated `docs/openapi.json` has 25 paths.

---

## LOPC-11: Phase 9 — CI/CD, Security Hardening, and Documentation

**Goal:** Automated deploys on push to `main`, all security controls active end-to-end, full developer documentation written.

**Notes:** GitHub Actions secrets must be documented so any team member can set them up. OpenAPI spec must be auto-generated — not hand-written. Security headers follow OWASP recommendations for REST APIs.

- [x] LOPC-11-1: `.github/workflows/deploy-cloudflare.yml` — push to main → bun install → bun test → wrangler deploy
- [x] LOPC-11-2: `.github/workflows/deploy-vercel.yml` — push/PR to main → bun install → bun test → vercel --prod
- [x] LOPC-11-3: CORS enforcement updated in router.ts — 403 for requests with unlisted Origin header
- [x] LOPC-11-4: Security headers added: X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy
- [x] LOPC-11-5: All write handlers use Zod validation (inline); no missing schemas found
- [x] LOPC-11-6: `scripts/gen-openapi.ts` — generates `docs/openapi.json` (25 paths, OpenAPI 3.1)
- [x] LOPC-11-7: `README.md` written — architecture, env vars table, local dev, deploy, testing
- [x] LOPC-11-8: `docs/schema.md` written — all 10 tables with columns, types, constraints, FK relationships
- [x] LOPC-11-9: `SECURITY.md` written — vulnerability reporting, auth model, known limitations

**Review**
130 tests still pass after router.ts hardening. ALLOWED_ORIGINS='*' in test env bypasses origin rejection as expected. OpenAPI spec generated with 25 paths and correct security schemes.

---

## LOPC-12: Testing Infrastructure

**Goal:** Consistent test setup across unit, integration, and E2E layers; coverage reporting wired into CI; helpers reduce boilerplate in individual test files.

**Notes:** `bun test` is the runner throughout. Unit tests mock the DB client via `mock.module`. Integration tests use a Turso test database (`lopc-test`) provisioned in CI with fresh migrations before each run. E2E tests call a running `wrangler dev` local Worker via fetch. Do not use `node`, `npm`, or `vitest`.

- [x] LOPC-12-1: `src/test/helpers.ts` — `makeRequest`, `makeAuthHeader`, `buildTestEnv`, `mockDb`
- [x] LOPC-12-2: `src/test/setup.ts` — env validation; warns when DB_SRC=turso vars missing
- [x] LOPC-12-3: `.env.test.example` verified complete (DB_SRC, TURSO_*, JWT_*, ALLOWED_ORIGINS, ENVIRONMENT)
- [x] LOPC-12-4: `bun test --coverage` available as `bun run test:coverage` (already existed); Bun 1.3.9 does not support threshold config in package.json
- [x] LOPC-12-5: `test/e2e/smoke.test.ts` — guarded by `E2E=1` env var; tests GET /, POST /auth/register, GET /products
- [x] LOPC-12-6: `bun run e2e` script already existed (`E2E=1 bun test test/e2e/`)
- [x] LOPC-12-7: Coverage via `bun test --coverage` in CI; no Codecov integration (not in scope)

**Review**
130 pass, 3 skip (E2E tests guarded by E2E=1). Smoke tests spawn wrangler dev and poll until ready. `bunfig.toml` exclude is non-functional in Bun 1.3.9 — describe.if guard used instead. Helpers are additive; existing tests not refactored.

---

## LOPC-13: Stripe Webhook Ingestion

**Goal:** Ingest Stripe checkout events to create orders with full order/product/customer data separation. Sync local products to Stripe so they can be used in Checkout Sessions. Store a Stripe Customer ID per user.

**Notes:**

### Webhook event strategy
Listen to two events:
- `checkout.session.completed` — fires when session closes (covers card payments)
- `checkout.session.async_payment_succeeded` — fires when async payment methods (ACH, SEPA) later confirm

Always check `session.payment_status !== 'unpaid'` before fulfilling. Use the Stripe event `id` for idempotency — deduplicate against a `processed_webhook_events` table to handle Stripe's retry-on-failure behavior.

### Signature verification (Cloudflare Workers)
The raw request body **must** be read as bytes before any JSON parsing — re-serialised JSON fails HMAC verification. On CF Workers use `constructEventAsync` (async), not `constructEvent` (sync Node.js only). Alternatively verify using `crypto.subtle` directly (no SDK dependency).

```typescript
// CF Workers — read raw bytes first
const payload = Buffer.from(await request.arrayBuffer());
const event = await stripe.webhooks.constructEventAsync(
  payload,
  request.headers.get('stripe-signature'),
  env.STRIPE_WEBHOOK_SECRET
);
```

### Line items are NOT in the webhook payload
After receiving `checkout.session.completed`, call the Stripe API to expand line items:
```typescript
const session = await stripe.checkout.sessions.retrieve(event.data.object.id, {
  expand: ['line_items'],
});
```
Each line item has `price.id`, `price.product`, `quantity`, `amount_total`. Map `price.product` (Stripe product ID) back to a local product via `stripe_product_id` column.

### Product sync strategy
Local DB is source of truth; Stripe is the billing layer. On product create/update in the local API:
1. Create/update a Stripe Product + Price
2. Store `stripe_product_id` and `stripe_price_id` on the local product row

Stripe Prices are immutable after creation. Price changes require creating a new Price and archive the old one, then update `stripe_price_id` locally.

### Customer sync strategy
On user register or first checkout, create a Stripe Customer and store `stripe_customer_id` on the user row. Pass this to Checkout Sessions so payments are associated with the correct customer in Stripe Dashboard.

### Data model additions needed
- `products` table: add `stripe_product_id TEXT`, `stripe_price_id TEXT`
- `users` table: add `stripe_customer_id TEXT`
- `orders` table: add `stripe_session_id TEXT UNIQUE` (idempotency + audit), `stripe_payment_intent_id TEXT`, `source TEXT` (enum `'api' | 'stripe'`, default `'api'`), `shipping_address_id TEXT` (FK → addresses), `billing_address_id TEXT` (FK → addresses)
- `order_lines` table: add `stripe_price_id TEXT` (the Stripe Price ID used, for audit trail)
- New table: `processed_webhook_events (stripe_event_id TEXT PRIMARY KEY, processed_at TEXT NOT NULL)`

### Address handling during Stripe fulfillment
Stripe's `checkout.session.completed` payload contains:
- `session.shipping_details` → `{ name, address: { line1, line2, city, state, postal_code, country } }`
- `session.customer_details` → `{ email, name, address }` (billing address)

Fulfillment handler must:
1. Upsert shipping address into `addresses` table linked to the customer (`type = 'shipping'`)
2. Upsert billing address into `addresses` table linked to the customer (`type = 'billing'`) if different from shipping
3. Set `orders.shipping_address_id` and `orders.billing_address_id` on the created order
4. If customer came via guest checkout (no prior account), create a minimal user + customer row from `customer_details.email`

---

### Subtasks

- [x] LOPC-13-1: DB schema migration — add `stripe_product_id`, `stripe_price_id` to products; add `stripe_customer_id` to users; add `stripe_session_id` (UNIQUE), `stripe_payment_intent_id`, `source`, `shipping_address_id`, `billing_address_id` to orders; add `stripe_price_id` to order_lines; create `processed_webhook_events` table
- [x] LOPC-13-2: Stripe client module `src/lib/stripe.ts` — lazy-initialise Stripe SDK (CF Workers compatible); export `getStripe(env)` helper
- [x] LOPC-13-3: Product sync — on `POST /products` and `PUT /products/:id`, create/update Stripe Product + Price; store IDs back to local row; archive old price on price change
- [x] LOPC-13-4: Customer sync — on `POST /auth/register`, create a Stripe Customer and store `stripe_customer_id` on the user; backfill for existing users on first login
- [x] LOPC-13-5: ~~Checkout Session creation endpoint `POST /checkout/session`~~ — **Removed**. This is an admin-facing API, not customer-facing. `src/api/checkout.ts` and its 5 tests were deleted; import removed from `app.ts`.
- [x] LOPC-13-6: Webhook endpoint `POST /webhooks/stripe` — reads raw body as `ArrayBuffer`, verifies signature via `constructEventAsync`, routes `checkout.session.completed` and `checkout.session.async_payment_succeeded` to fulfillment handler
- [x] LOPC-13-7: Fulfillment handler extracted to `src/lib/stripe-fulfill.ts` (shared between webhook and admin sync) — idempotency check against `processed_webhook_events`; fetch line items via Stripe API; map Stripe line items to local product IDs via `stripe_product_id`; upsert shipping address from `session.shipping_details` / `session.customer_details`; create guest user+customer row if no existing account for that email; insert into `orders` + `order_lines` in a single DB transaction; mark event processed
- [x] LOPC-13-8: `AppEnv` — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` typed; `STRIPE_PUBLISHABLE_KEY` optional
- [x] LOPC-13-9: Tests — unit tests for signature verification, fulfillment handler with mocked Stripe client and DB; test idempotency (duplicate event ID rejected). 138 tests pass / 3 skip / 0 fail.
- [x] LOPC-13-10: `POST /admin/sync/stripe` (admin-only) — 5-step bidirectional sync:
  - Step 1: Stripe active products → local DB (import missing, dedupe slugs)
  - Step 2: Local products without Stripe IDs → Stripe (create Product + Price)
  - Step 3: Stripe customers → local DB (create guest user rows for unknown emails; link `stripeCustomerId` for known)
  - Step 4: Local users without `stripeCustomerId` → Stripe (look up by email or create)
  - Step 5: Historical paid checkout sessions → local orders via `fulfillCheckoutSession` (idempotent)
  - Response: `{ products: { imported, created, synced, skipped }, customers: { imported, synced, created, skipped }, orders: { imported, skipped } }`
- [x] LOPC-13-11: Webhook setup documented in `docs/commands.md` (curl cheatsheet with token, sync, webhook examples)

**Review**

138 tests pass / 3 skip / 0 fail. Key implementation decisions:
- `getStripe()` uses `Stripe.createFetchHttpClient()` for CF Workers compatibility; API version pinned to `2026-02-25.clover`
- Webhook verification uses `constructEventAsync` (required on CF Workers — sync variant uses Node.js crypto)
- Checkout endpoint removed — system is admin-facing only
- Fulfillment logic extracted to `src/lib/stripe-fulfill.ts` shared by webhook handler and admin sync
- Idempotency enforced at DB level via `processed_webhook_events` table within a DB transaction
- Admin sync Step 5 uses `session.id` as the idempotency event key

---

## LOPC-14: Fix Stripe `listLineItems` in `fulfillCheckoutSession`

**Goal:** Replace the failing 4-level deep `checkout.sessions.retrieve + expand` call with the dedicated `listLineItems` endpoint, which is shallower, paginated, and the Stripe-recommended pattern for post-session fulfillment.

**Problem:** `stripe.checkout.sessions.retrieve(id, { expand: ['line_items', 'line_items.data.price.product'] })` hits the documented 4-level expand maximum. On Cloudflare Workers this times out, the SDK retries twice, then throws `StripeConnectionError: An error occurred with our connection to Stripe. Request was retried 2 times.` — confirmed by GitHub issue stripe/stripe-node#2493 which reproduces with this exact call on CF Workers. Additionally the current code silently truncates orders with many items (expand on retrieve returns only "the first handful").

**Root cause:** The expand path `line_items.data.price.product` is exactly at the 4-level limit and fans out to fetch every product per line item. Other Stripe calls in the same worker succeed because they are shallow.

**Fix:** Use `stripe.checkout.sessions.listLineItems(session.id, { limit: 100, expand: ['data.price.product'] })` — 3 levels deep, paginated, designed for this use case.

- [x] LOPC-14-1: In `src/lib/stripe-fulfill.ts`, replace the `sessions.retrieve + expand` block with `sessions.listLineItems` call
- [x] LOPC-14-2: Update the line item iteration to use the `listLineItems` response (same `.data` shape)
- [x] LOPC-14-3: Update `stripe.test.ts` — replace `mockCheckoutSessionsRetrieve` with `mockListLineItems` mock; update the mock instance and assertions
- [x] LOPC-14-4: `bun run test` → 138 pass / 3 skip / 0 fail
- [x] LOPC-14-5: `bun run deploy:cf` → `POST /admin/sync/stripe` returns `{ orders: { imported: 8, skipped: 1 } }` — 8 historical orders imported successfully

**Review**

Root cause: `sessions.retrieve` with `expand: ['line_items', 'line_items.data.price.product']` hits the 4-level Stripe expand limit and times out in CF Workers (stripe/stripe-node#2493). The dedicated `sessions.listLineItems` endpoint uses a 3-level expand (`data.price.product`), is paginated, and is the Stripe-recommended pattern for post-session fulfillment. Individual session errors are now caught and counted as skipped (resilient loop) rather than aborting the whole sync.

---

## LOPC-15: Rewrite admin sync Step 5 using Stripe charges as source of truth

**Goal:** Replace the session-based historical order import in `POST /admin/sync/stripe` Step 5 with a charges-based approach that mirrors the Stripe Dashboard "Transactions" view. Key idempotency on `stripe_payment_intent_id` in the `orders` table directly (no `processedWebhookEvents` involvement). Import both succeeded and refunded charges.

**Why:** `checkout.sessions.list` is unreliable as a historical source — sessions can be incomplete, expired, or missing customer context. Charges (`stripe.charges.list`) are the canonical record of money movement and naturally map to `payment_intent_id`, providing a clean idempotency key already stored in the schema. This also makes order data easy to decorate for third-party systems (ERP, fulfillment, accounting).

**Also fix:** DB cleanup script — Turso/SQLite FK chain blocks naive DELETE. The dependency order is `order_lines → orders → addresses → customers → users`. A script makes it easy to reset broken imports during development.

**Subtasks:**

- [x] LOPC-15-1: Create `scripts/cleanup-db.ts` — delete all transactional rows in correct FK order (order_lines, orders, addresses, customers, users), preserving the admin user and all products
- [x] LOPC-15-2: In `src/api/admin-sync.ts` Step 5, replace `checkout.sessions.list` loop with `stripe.charges.list` loop — idempotent on `stripePaymentIntentId`, lookup session via `sessions.list({ payment_intent })`, then `listLineItems` for line items
- [x] LOPC-15-3: Customer lookup in Step 5 by `users.stripeCustomerId` (not email) — skip charges for unknown customers with a log (Steps 3/4 already reconciled customers before Step 5 runs)
- [x] LOPC-15-4: Set `order.status` from charge — `charge.refunded → 'refunded'`; otherwise `'confirmed'`; set `refundedAmount` from `charge.amount_refunded / 100`
- [x] LOPC-15-5: Update `stripe.test.ts` — add `mockChargesList` to mock instance; update the admin sync test to mock one charge and assert one order created; existing webhook tests untouched
- [x] LOPC-15-6: `bun run test` → 139 pass / 3 skip / 0 fail
- [x] LOPC-15-7: Update `lessons.md` — add lesson about charges as sync source of truth and FK delete ordering

---

## LOPC-16: Ensure Stripe-imported orders always have customer + shipping + billing linkage

**Goal:** Make `POST /admin/sync/stripe` produce operationally complete orders for downstream systems. Every imported order must have:
- a valid `customer_id`
- non-null `shipping_address_id`
- non-null `billing_address_id`

When Stripe data is incomplete, use a DB-seeded placeholder address so imports stay consistent and auditable.

**Problem:** Current charge-based import can create orders without addresses and without order lines. This makes fulfillment/reporting difficult because there is no guaranteed receiver identity on the order.

**Approach:** Seed one system placeholder user/customer/address via migration. In admin sync Step 5, resolve real address from Stripe charge payload when possible; otherwise link both shipping and billing IDs to placeholder.

### Subtasks

- [x] LOPC-16-1: Add migration `src/db/migrations/0004_*` to seed placeholder entities (system user, system customer, placeholder address) with deterministic IDs; update migration journal metadata
- [x] LOPC-16-2: Update `src/api/admin-sync.ts` Step 5 to preload placeholder IDs and always set both `shippingAddressId` and `billingAddressId` on inserted orders
- [x] LOPC-16-3: In Step 5, map charge billing address when complete; otherwise use placeholder address ID for missing shipping/billing values
- [x] LOPC-16-4: Keep customer resolution resilient (existing user by stripeCustomerId/email, create guest user/customer when needed)
- [x] LOPC-16-5: Update `src/api/stripe.test.ts` admin sync tests to assert imported charge orders have non-null shipping and billing IDs
- [x] LOPC-16-6: Run migrations with `bun run db:migrate` and verify placeholder rows exist
- [x] LOPC-16-7: Run full test suite `bun run test`
- [x] LOPC-16-8: Run `bun run scripts/cleanup-db.ts`, then run Stripe sync, then verify via API response + DB snapshot that imported orders include customer + shipping + billing linkage

### Verification checkpoints

- [ ] API: `POST /admin/sync/stripe` returns successful sync stats without processing errors
- [x] DB: `orders` rows imported from Stripe have non-null `customer_id`, `shipping_address_id`, and `billing_address_id`
- [x] DB: placeholder address exists and is linked only where Stripe address data is missing

---

## LOPC-17: Phased Stripe admin sync to avoid subrequest limits

**Goal:** Make `POST /admin/sync/stripe` run safely under Cloudflare subrequest limits by introducing explicit execution phases backed by `stripe_order_import_staging`:
1) **Stage** (Stripe -> staging only)
2) **Finalize** (staging -> orders in bounded batches)
3) **Status** (backlog visibility for operators/scripts)

This keeps imports deterministic, retry-safe, and resumable across multiple requests.

### Subtasks

- [x] LOPC-17-1: Add DB migration `0005_*` creating `stripe_order_import_staging` table and unique index on `orders.stripe_payment_intent_id`
- [x] LOPC-17-2: Add staging table schema to `src/db/schema.ts`
- [x] LOPC-17-3: Refactor `src/api/admin-sync.ts` Step 5 into staged -> finalized flow with stats `orders: { staged, finalized, skipped, failed }`
- [x] LOPC-17-4: Update cleanup script to clear staging table (`scripts/cleanup-db.ts`)
- [x] LOPC-17-5: Add explicit sync phase controls in `src/api/admin-sync.ts` (`phase=all|stage|finalize|status`) and bounded finalize batch controls
- [x] LOPC-17-6: Update `scripts/sync-via-api.ts` to orchestrate stage once + repeated finalize calls until backlog drains
- [ ] LOPC-17-7: Update tests (`src/api/stripe.test.ts`) for phase-aware behavior and iterative finalize assertions
- [x] LOPC-17-8: Deploy, then run cleanup -> staged/finalize loop -> DB snapshot verification flow

### Verification checkpoints

- [x] API: `phase=status` reports backlog counts (`pending`, `failed`, `finalized`) and `remainingToFinalize`
- [ ] API: `phase=stage` completes without finalization side effects
- [x] API: repeated `phase=finalize` calls drain backlog to zero without subrequest-limit failures
- [x] DB: finalized stripe orders have non-null `customer_id`, `shipping_address_id`, `billing_address_id`
- [x] DB: no duplicate `stripe_payment_intent_id` in orders

---

## LOPC-18: Stripe parity import completion (addresses + order_lines)

**Goal:** Fix the remaining import parity gap without broad refactors: ensure imported Stripe orders have usable address data and order lines that match Stripe source data.

### Subtasks

- [x] LOPC-18-1: Add a parity verification script that selects one imported order and compares DB `orders` + `addresses` + `order_lines` against Stripe charge + Checkout Session line items
- [x] LOPC-18-2: Run clean baseline (`bun run scripts/cleanup-db.ts`) and phased resync (`bun run scripts/sync-via-api.ts`)
- [x] LOPC-18-3: Execute parity verification script and capture exact mismatches (address fields, missing lines, amount differences)
- [x] LOPC-18-4: Apply minimal targeted fix for address import in admin sync (no broad workflow changes)
- [x] LOPC-18-5: Apply minimal targeted fix for `order_lines` import in admin sync (no broad workflow changes)
- [x] LOPC-18-6: Add focused tests in `src/api/stripe.test.ts` for address + `order_lines` parity from admin sync
- [x] LOPC-18-7: Re-run clean baseline + phased resync + parity script and confirm idempotency on second run

### Verification checkpoints

- [x] DB reset verified before sync (`orders`, `order_lines`, `addresses` empty except seeded placeholders)
- [x] API sync completes without fatal processing errors
- [x] Imported Stripe orders have valid customer + shipping + billing linkage
- [x] Imported Stripe orders have non-zero `order_lines` when Stripe session contains line items
- [x] One selected imported order matches Stripe transaction/session for totals, refunded amount, addresses, and line items
- [x] Re-running sync does not create duplicates in `orders` or `order_lines`

### Current findings (latest clean baseline run)

- `scripts/verify-order-parity.ts` now reports `mismatchCount: 0` after cleanup + phased resync.
- `scripts/db-snapshot.ts` confirms imported stripe orders have real address links and `order_lines` is populated (`order_lines: 10`).
- `scripts/sync-via-api.ts` default finalize batch reduced to `3` to avoid Cloudflare subrequest-limit failures during parity import.

---

## LOPC-19: Admin data-health endpoint

**Goal:** Add `GET /admin/data-health` (diagnostic snapshot) and `POST /admin/data-health` (mutation actions) so all orphan cleanup, deduplication, and webhook fix operations can be driven through the API rather than direct DB access. This endpoint will be consumed by an admin UI.

### Subtasks

- [x] LOPC-19-1: Create `src/api/admin-data-health.ts` with `GET /admin/data-health` returning diagnostic snapshot (orphan counts, duplicate address groups, stuck webhook orders)
- [x] LOPC-19-2: Implement `POST /admin/data-health?action=purge-orphans` — delete orphan order_lines, shipments, unreferenced addresses, empty customers; respects FK order
- [x] LOPC-19-3: Implement `POST /admin/data-health?action=dedupe-addresses` — for each duplicate address group keep the order-referenced row (or lowest UUID), delete the rest
- [x] LOPC-19-4: Implement `POST /admin/data-health?action=mark-webhook-processed&eventId=evt_...` — insert event ID into `processed_webhook_events` to stop Stripe retry 500s
- [x] LOPC-19-5: Implement `POST /admin/data-health?action=rollback-order&paymentIntentId=pi_...` — delete order_lines + order + processed_webhook_events row so the same event can be resent fresh
- [x] LOPC-19-6: Register module in `src/app.ts`
- [x] LOPC-19-7: Add `src/api/admin-data-health.test.ts` covering all actions + auth enforcement

### Verification checkpoints

- [x] `GET /admin/data-health` returns structured JSON with all diagnostic fields — suitable for UI table rendering
- [x] `POST ?action=purge-orphans` removes all orphan rows, returns deleted counts
- [x] `POST ?action=dedupe-addresses` removes duplicate addresses, preserves order-linked rows
- [x] `POST ?action=mark-webhook-processed` inserts event ID; second call returns `alreadyPresent: true`
- [x] `POST ?action=rollback-order` removes order + lines + event row; Stripe resend then creates fresh order
- [x] Non-admin token returns `403` on both methods
- [x] All new tests pass; full suite 0 failures

---

## LOPC-20: Comprehensive API documentation

**Goal:** Write table-style, grouped API documentation for every endpoint in the project so that frontend developers and external contributors have a single source of truth for inputs, outputs, status codes, and auth requirements.

**Notes:** Docs live in `docs/api/` and are split one file per endpoint group. Each endpoint documents: auth level, path/method, query parameters, request body fields, response body fields, and error responses — all in Markdown table format.

### Subtasks

- [x] LOPC-20-1: Create `docs/api/` directory
- [x] LOPC-20-2: Write `docs/api/README.md` — index with auth explanation, response envelope, status code reference, and table of all groups + counts
- [x] LOPC-20-3: Write `docs/api/discovery.md` — `GET /`
- [x] LOPC-20-4: Write `docs/api/auth.md` — 6 auth endpoints with full input/output tables
- [x] LOPC-20-5: Write `docs/api/products.md` — 8 product + variant endpoints
- [x] LOPC-20-6: Write `docs/api/categories.md` — 5 category endpoints
- [x] LOPC-20-7: Write `docs/api/customers.md` — 9 customer + address endpoints
- [x] LOPC-20-8: Write `docs/api/orders.md` — 6 order lifecycle endpoints with status transition table
- [x] LOPC-20-9: Write `docs/api/logistics.md` — 5 shipment endpoints with status value reference
- [x] LOPC-20-10: Write `docs/api/admin.md` — 7 admin endpoints (sync, data-health GET/POST with all 4 actions, dashboard, 3 reports)
- [x] LOPC-20-11: Write `docs/api/webhooks.md` — Stripe webhook endpoint with fulfillment flow description

### Review

48 endpoints documented across 9 files. Every endpoint includes: auth level, path parameters, query parameters, request body fields table (required/type/description), response body fields table, and error responses table. Status transition table added for orders. Shipment status values table added for logistics. All 4 data-health mutation actions documented with individual request/response examples.

---

## LOPC-21: Deterministic Stripe Sync Refactor

**Goal:** Completely rewrite the Stripe sync pipeline so that every run produces identical, verifiable results regardless of timing, concurrency, or network variance. Fix the archive-state bug where every imported product ends up active. Eliminate the dual-writer race between webhooks and admin sync.

**Decisions (locked with product owner):**
- Stripe is the source of truth for product publish/archive state.
- Webhooks are gated during historical backfill (ack + defer, no order writes).
- Unknown Stripe products during order finalize: fail/skip for manual mapping (no auto-create).

### Phase A: Data Integrity Foundation (Steps 1-5)

- [x] LOPC-21-1: Add migration `0006_*` with three changes: (a) `CREATE UNIQUE INDEX products_stripe_product_id_unique ON products(stripe_product_id) WHERE stripe_product_id IS NOT NULL` to prevent ambiguous product mappings, (b) `ALTER TABLE stripe_order_import_staging ADD COLUMN claimed_at TEXT DEFAULT NULL` for lease-based finalize, (c) `ALTER TABLE stripe_order_import_staging ADD COLUMN claimed_by TEXT DEFAULT NULL` for worker identification. Run `bunx drizzle-kit generate` then `bunx drizzle-kit push`. Before applying: write and run a dedup script that resolves any existing duplicate `stripe_product_id` rows (keep the row with orders referencing it, merge the other's order_lines, delete the loser).

- [x] LOPC-21-2: Update `src/db/schema.ts` to reflect the new unique index on `products.stripe_product_id`, the new `claimedAt`/`claimedBy` columns on staging, and add a new `processing` value to the staging status enum (`pending | processing | finalized | failed`). The schema must match the migration exactly.

- [x] LOPC-21-3: Write a canonical `mapStripeProductStatus` function in a new file `src/lib/stripe-product-status.ts` that maps `Stripe.Product` -> local product status: `active=true` -> `'active'`, `active=false` -> `'archived'`. This function is the SINGLE source of truth for status mapping. Export it and import it everywhere that touches product status from Stripe. Write 4 unit tests: active->active, inactive->archived, deleted product->archived, edge cases (missing field defaults to archived).

- [x] LOPC-21-4: Audit and fix every product creation/update path that touches Stripe data. There are exactly 3 locations that hardcode `status: 'active'`:
  (a) `src/api/admin-sync.ts` line ~119: `insertOrderLinesFromStripeSession` auto-creates missing products as `'active'` -- REMOVE this entire auto-create block; replace with a log + skip + increment `orderStats.failed` with reason `'unknown_product'`.
  (b) `src/api/admin-sync.ts` line ~410: catalog import from Stripe sets `status: 'active'` -- replace with `status: mapStripeProductStatus(sp)` using the Stripe product object.
  (c) `src/lib/stripe-fulfill.ts` line ~179: webhook fulfillment auto-creates missing products as `'active'` -- REMOVE this auto-create block entirely; replace with log + skip. If product not found locally, skip the line item and log `[stripe-fulfill] Unknown product ${stripeProductId}, skipping line item`.
  After this step: no code path can create a product with status derived from anything other than `mapStripeProductStatus`.

- [x] LOPC-21-5: Extend catalog sync (Step 1 in admin-sync.ts, the `stripe.products.list` loop) to also fetch `active: false` products from Stripe by making a second paginated pass with `active: false`. For each inactive Stripe product that exists locally and is NOT already `'archived'`, update it to `'archived'`. For each inactive Stripe product that does NOT exist locally, insert it as `'archived'`. This ensures the local catalog is a mirror of Stripe state. Add counters: `productStats.archived` for status changes and `productStats.importedArchived` for new archived inserts.

### Phase B: Deterministic Staging (Steps 6-10)

- [x] LOPC-21-6: Rip out the caller-managed `stageCursor` / `stagePages` / `stagePageLimit` system from admin-sync.ts. Replace with a DB-persisted high-water mark: create a new table `sync_cursors` with columns `(id TEXT PK, cursor_type TEXT NOT NULL, cursor_value TEXT NOT NULL, updated_at TEXT NOT NULL)`. On each stage run, read the `stripe_charges` cursor row to get `starting_after`, page through ALL remaining charges (no page limit), and on completion write the last charge ID back. If the cursor row doesn't exist, start from the beginning. This means `phase=stage` is resumable and deterministic: each charge is visited exactly once across all runs.

- [x] LOPC-21-7: Fix the staging upsert conflict clause. Currently `ON CONFLICT(stripe_payment_intent_id) DO UPDATE SET ... status = 'pending'` -- this RESETS already-finalized rows back to pending, causing re-processing and data variance. Change to: `ON CONFLICT(stripe_payment_intent_id) DO UPDATE SET ... status = CASE WHEN stripe_order_import_staging.status IN ('finalized') THEN stripe_order_import_staging.status ELSE 'pending' END`. Never touch a finalized row. This is the single biggest cause of "different data each run".

- [x] LOPC-21-8: Add a `knownPaymentIntents` pre-check that also includes staging table rows (not just orders table). Currently the stage loop checks `orders.stripe_payment_intent_id` but NOT `stripe_order_import_staging.stripe_payment_intent_id`, so PIs already in staging get upserted every run. Build the set from BOTH tables. Combined with step 7, this eliminates redundant upserts entirely.

- [x] LOPC-21-9: Add strict ordering to finalize row selection. Currently `SELECT ... FROM staging WHERE status IN ('pending','failed') LIMIT N` with no ORDER BY -- SQLite returns rows in arbitrary order, so different runs process different rows. Change to `ORDER BY created_at ASC, id ASC` so finalize is deterministic and FIFO. Failed rows are retried in creation order.

- [x] LOPC-21-10: Implement lease-based claim for finalize. Before processing a batch: `UPDATE staging SET status='processing', claimed_at=datetime('now'), claimed_by=? WHERE id IN (SELECT id FROM staging WHERE status IN ('pending','failed') AND (claimed_at IS NULL OR claimed_at < datetime('now', '-5 minutes')) ORDER BY created_at ASC, id ASC LIMIT ?)`. Process claimed rows. On success: set `status='finalized'`. On failure: set `status='failed'`, `last_error=?`, increment `attempts`. On crash: stale claims (>5 min) are reclaimed by next run. This prevents concurrent finalize calls from racing on the same rows.

### Phase C: Finalize Correctness (Steps 11-14)

- [x] LOPC-21-11: Remove product auto-creation from `insertOrderLinesFromStripeSession`. When a Stripe line item references a `stripe_product_id` not in the local products table, skip the line item and log the skip. After all line items processed, if zero lines were resolved, mark the staging row as `failed` with `last_error = 'no_resolvable_line_items'`. Do NOT mark it `finalized` (current code marks it finalized even with zero lines -- this is the silent data loss bug).

- [x] LOPC-21-12: Add a post-finalize integrity check inside the finalize loop. After inserting the order + lines, verify: (a) the order row exists AND (b) `COUNT(order_lines) > 0` for that order. If either check fails, rollback: delete the order row and mark staging as `failed` with reason. Only set `finalized` after this check passes.

- [x] LOPC-21-13: Make finalize set `stripe_session_id` on the order when available. Currently the finalize path sets `stripe_session_id = NULL` even when it successfully fetched the session (the `NULL` is hardcoded in the INSERT). Change to pass `session?.id ?? null` so orders created by admin sync have session traceability.

- [x] LOPC-21-14: Handle refunded orders correctly in finalize. Currently if `staged.refunded === 1` the code sets `notes = 'refunded'` but `status = 'confirmed'`. If the charge is fully refunded, set `status = 'refunded'` and `refunded_amount = staged.amount_refunded`. If partially refunded, set `status = 'confirmed'` but still populate `refunded_amount`. Add a test for each case.

### Phase D: Webhook Gating (Steps 15-16)

- [x] LOPC-21-15: Add a `backfill_active` flag. Approach: check for pending/processing rows in `stripe_order_import_staging` at webhook time. In `src/lib/stripe-fulfill.ts`, before inserting the order, query for the payment intent in the staging table. If a staging row exists with `status IN ('pending','processing')`, return `false` (defer) and log `[stripe-fulfill] PI ${piId} is in staging, deferring webhook fulfillment`. The webhook handler in `src/api/webhooks.ts` still returns `200 { received: true }` to Stripe (acknowledge receipt), but the order is not written. Stripe will retry, and once the staging row is finalized or absent, the webhook will be processed normally OR the finished order from admin sync will satisfy the idempotency check.

- [x] LOPC-21-16: Add a `processed_webhook_events` row during admin-sync finalize so that completed staged orders don't get double-created when Stripe retries the webhook. After finalize inserts the order, also insert a synthetic event ID (`admin-sync:${staged.stripePaymentIntentId}`) into `processed_webhook_events`. The webhook fulfillment idempotency check will find this row and skip.

### Phase E: API Surface Alignment (Steps 17-18)

- [x] LOPC-21-17: Align the query parameter names between docs and code. Docs say `batchSize`, code reads `finalizeBatch`. Docs say phase values `all|stage|finalize|status`, code also accepts `catalog`. Pick one: rename the code parameter from `finalizeBatch` to `batchSize` for consistency with docs, and document `catalog` as a valid phase value. Update the `badRequest` validation message. Update `docs/api/admin.md` to match.

- [x] LOPC-21-18: Update `docs/api/admin.md`, `docs/schema.md`, `llms.txt`, and the `GET /admin/data-health` response to reflect all changes: new staging columns (`claimed_at`, `claimed_by`), new staging status value (`processing`), new `sync_cursors` table, new product archive counters, webhook gating behavior, and corrected parameter names. Add a "Backfill Runbook" section to `docs/api/admin.md` explaining the safe operational sequence: `phase=catalog` -> `phase=stage` -> repeat `phase=finalize&batchSize=3` until `remainingToFinalize=0` -> verify via `phase=status` and `GET /admin/data-health`.

### Phase F: Testing and Verification (Steps 19-20)

- [x] LOPC-21-19: Write deterministic replay tests in `src/api/stripe-sync.test.ts` (new file). Required test cases:
  (a) Same Stripe charge fixture staged twice -> staging table has exactly 1 row, not 2.
  (b) Finalized row is NOT reset to pending by a subsequent stage pass.
  (c) Finalize with unknown product -> row marked `failed`, NOT `finalized`.
  (d) Finalize with zero resolved line items -> row marked `failed`, order NOT created.
  (e) Lease-based claim: two concurrent finalize calls don't process the same row.
  (f) Archive mapping: `Stripe.Product{active:false}` -> local `status='archived'`, never `'active'`.
  (g) Webhook gating: webhook with PI in staging returns false (deferred), order not created.
  (h) Webhook after finalize: processed_webhook_events has the synthetic admin-sync entry, webhook is no-op.
  (i) Full end-to-end replay: catalog sync -> stage -> finalize -> verify order count and line_items match fixture. Run twice, assert identical DB state.

- [x] LOPC-21-20: Production verification sequence (manual, but scripted via `scripts/sync-verify.ts`). Steps:
  (a) Run `bun run scripts/cleanup-db.ts` for clean baseline.
  (b) `POST /admin/sync/stripe?phase=catalog` -- verify product count matches Stripe (active + archived).
  (c) `POST /admin/sync/stripe?phase=stage` -- verify staging row count matches Stripe paid charges.
  (d) `POST /admin/sync/stripe?phase=status` -- capture `{ pending, finalized, failed }` baseline.
  (e) Loop `POST /admin/sync/stripe?phase=finalize&batchSize=3` until `remainingToFinalize = 0`.
  (f) `POST /admin/sync/stripe?phase=status` -- assert `pending=0, failed=0` (or document permanently failing rows with reasons).
  (g) `GET /admin/data-health` -- assert zero orphans, zero stuck webhook orders.
  (h) Run steps (b)-(g) a SECOND time. Assert zero new rows created (full idempotency).
  (i) Compare product statuses against Stripe: every `active:false` Stripe product must be `archived` locally, every `active:true` must be `active` locally. Zero mismatches.
  (j) Select 3 random imported orders, run `scripts/verify-order-parity.ts` against Stripe source. Assert `mismatchCount: 0` for each.

### Verification checkpoints

- [x] No code path creates products with hardcoded `status: 'active'` from Stripe data; `mapStripeProductStatus` is the only authority
- [x] `products.stripe_product_id` has a unique index; no duplicate mappings possible
- [x] Staging upsert never resets `finalized` rows to `pending`
- [x] Finalize selects rows in deterministic order (created_at ASC, id ASC)
- [x] Finalize uses lease-based claims; concurrent calls cannot race
- [x] Zero-line-item orders are never marked `finalized`; they are `failed`
- [x] Webhook fulfillment defers when payment intent is in staging
- [x] Admin-sync finalize writes a `processed_webhook_events` row to block duplicate webhook fulfillment
- [x] Running full sync twice from clean state produces byte-identical DB snapshots
- [x] All existing tests pass; new test file has 9+ test cases; zero failures

---

## LOPC-22: Wire Stripe refund API into POST /orders/:id/refund

**Goal:** The existing `/orders/:id/refund` endpoint only updated the local DB. Wire it to call `stripe.refunds.create()` so real money is returned to the customer when the order originated on Stripe.

**Scope:**
- `POST /orders/:id/refund`: if `order.stripePaymentIntentId` is set, call `stripe.refunds.create({ payment_intent, amount_in_cents })` before updating local DB. On Stripe failure return 500 without touching local state. API-created orders (no PI) skip Stripe silently.
- Response now includes `stripeRefundId` (`re_...` or `null`).
- 3 new tests: API order (no Stripe call), Stripe-originated order (verifies `refunds.create` called with cents), Stripe failure returns 500 and local DB unchanged.
- Docs updated: `docs/api/orders.md`, `llms.txt`.

- [x] LOPC-22-1: Import `getStripe` into `orders.ts`; add `serverError` to imports
- [x] LOPC-22-2: Refund handler calls `stripe.refunds.create()` when `stripePaymentIntentId` is set; converts dollars → cents; returns `stripeRefundId` in response
- [x] LOPC-22-3: Three new tests added to `orders.test.ts` (mock via `mock.module`)
- [x] LOPC-22-4: `docs/api/orders.md` updated — Stripe behaviour, response shape, error table
- [x] LOPC-22-5: `llms.txt` orders endpoint table updated
- [x] LOPC-22-6: 175 tests pass, 0 fail; deployed to production

---

## LOPC-23: Preserve Stripe transaction dates on imported orders

**Goal:** Imported historical orders must keep their original Stripe transaction timestamp, not the import runtime timestamp.

**Scope:**
- Stage step writes `stripe_order_import_staging.created_at` from `charge.created` (`datetime(unixepoch)`).
- Finalize step writes `orders.created_at` and `orders.updated_at` from staged transaction timestamp.
- Added regression test: finalize creates order with `createdAt = 2024-01-15 12:00:00` for fixed fixture epoch.
- Updated docs: `docs/api/admin.md`, `llms.txt`.

- [x] LOPC-23-1: Stage insert uses Stripe `charge.created` instead of `datetime('now')`
- [x] LOPC-23-2: Upsert preserves created_at for finalized rows; refreshes for non-finalized rows
- [x] LOPC-23-3: Finalize inserts order timestamps from staged transaction time
- [x] LOPC-23-4: Added regression test in `src/api/stripe-sync.test.ts`
- [x] LOPC-23-5: Updated affected Stripe charge fixtures in `stripe-sync.test.ts` and `stripe.test.ts`
- [x] LOPC-23-6: Full test suite passes (`176 pass / 0 fail / 3 skip`)
- [x] LOPC-23-7: Deployed to Cloudflare Workers (`Version ID: b4607889-01f5-4303-a0ac-9107e2630055`)
