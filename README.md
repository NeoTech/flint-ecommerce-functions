# LOPC API

A serverless e-commerce backend API. Handles authentication, products, categories, customers, orders, and logistics. Deployable on Cloudflare Workers and Vercel Edge.

## Architecture

- **Primary runtime**: Cloudflare Workers (V8 isolates, edge-deployed)
- **Secondary runtime**: Vercel Edge Functions
- **Local dev runtime**: Bun (native HTTP server, no Node.js required)
- **Database**: Turso (LibSQL/SQLite) with Drizzle ORM
- **Auth**: RS256 JWT (jose) with opaque refresh tokens stored in DB
- **Validation**: Zod on all request bodies
- **Rate limiting**: Cloudflare Workers native rate limiting (fails open on Vercel/local)

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TURSO_DB_URL` | Yes | Turso database URL (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | Yes | Turso auth token |
| `JWT_PRIVATE_KEY` | Yes | RS256 private key in PKCS8 PEM format |
| `JWT_PUBLIC_KEY` | Yes | RS256 public key in SPKI PEM format |
| `ALLOWED_ORIGINS` | Yes | Comma-separated allowed CORS origins, or `*` |
| `ENVIRONMENT` | Yes | `development`, `staging`, or `production` |
| `DB_SRC` | No | `turso` (default) or `local` (SQLite file for dev/test) |
| `STRIPE_SECRET_KEY` | Yes | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook signing secret |
| `BOOTSTRAP_SECRET` | Once | Secret for one-time admin creation — delete after use |
| `CLOUDFLARE_API_TOKEN` | CI/Deploy | CF API token (replaces `wrangler login`) |
| `CLOUDFLARE_ACCOUNT_ID` | CI/Deploy | CF account ID |

## Quickstart

### 1. Install dependencies

```bash
bun install
```

### 2. Create local secrets file

Wrangler and the Bun dev server both read `.dev.vars` (never committed):

```bash
cp .dev.vars.example .dev.vars   # if example exists, otherwise create manually
```

`.dev.vars` must contain:

```ini
TURSO_DB_URL=libsql://your-database.turso.io
TURSO_AUTH_TOKEN=your-turso-token

JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n..."

ALLOWED_ORIGINS=*
ENVIRONMENT=development
DB_SRC=turso

STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

CLOUDFLARE_API_TOKEN=your-cf-api-token
CLOUDFLARE_ACCOUNT_ID=your-cf-account-id
```

### 3. Generate RS256 keys

```bash
bun run gen-keys
```

Copy the output into `.dev.vars` as `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY`.

### 4. Run database migrations

```bash
bun run db:migrate
```

### 5. Start local dev server

```bash
bun run dev:bun
```

Server starts at `http://localhost:8787`. No Node.js required.

> `bun run dev` uses Wrangler which requires Node.js. Use `dev:bun` for pure-Bun local development.

### 6. Verify

```bash
curl http://localhost:8787/
```

Returns the full route manifest.

---

## Deploying to Cloudflare Workers

### 1. Push secrets to Cloudflare vault

```bash
bunx wrangler secret put JWT_PRIVATE_KEY
bunx wrangler secret put JWT_PUBLIC_KEY
bunx wrangler secret put TURSO_DB_URL
bunx wrangler secret put TURSO_AUTH_TOKEN
bunx wrangler secret put STRIPE_SECRET_KEY
bunx wrangler secret put STRIPE_WEBHOOK_SECRET
bunx wrangler secret put BOOTSTRAP_SECRET
```

Or push all at once from `.dev.vars`:

```bash
bunx wrangler secret bulk .dev.vars
```

> `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in `.dev.vars` are used automatically by wrangler — no `wrangler login` needed.

### 2. Deploy

```bash
bun run deploy:cf
```

### 3. Create the first admin account

```bash
curl -X POST https://your-worker.workers.dev/auth/bootstrap \
  -H "Content-Type: application/json" \
  -H "x-bootstrap-secret: YOUR_BOOTSTRAP_SECRET" \
  -d '{"email": "you@example.com", "password": "YourPassword123!"}'
```

Returns `201` with the admin user ID. After this the endpoint permanently returns `403` — it cannot be used again regardless of the secret.

### 4. Remove the bootstrap secret

```bash
bunx wrangler secret delete BOOTSTRAP_SECRET
```

---

## Deploying to Vercel

```bash
vercel env add TURSO_DB_URL
# repeat for all variables
vercel --prod
```

---

## Using the API

### Login and get a token

```bash
curl -X POST https://your-worker.workers.dev/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "YourPassword123!"}'
```

Response contains `accessToken` (15 min) and `refreshToken` (7 days).

### Call authenticated endpoints

```bash
curl https://your-worker.workers.dev/orders \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Refresh an expired token

```bash
curl -X POST https://your-worker.workers.dev/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken": "YOUR_REFRESH_TOKEN"}'
```

---

## API Endpoints

Run `GET /` to get the full route manifest. Key domains:

- `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `POST /auth/refresh`
- `POST /auth/forgot-password`, `POST /auth/reset-password`, `POST /auth/bootstrap`
- `GET /products`, `POST /products`, `PUT /products/:id`, `DELETE /products/:id`
- `GET /categories`, `POST /categories`
- `GET /customers/:id`, `PUT /customers/:id`
- `GET /orders`, `POST /orders`, `PUT /orders/:id/status`
- `GET /logistics/tracking/:trackingNumber`, `POST /logistics/shipments`
- `POST /webhooks/stripe` _(auth: none, signed by Stripe)_ — receive and process Stripe events
- `POST /admin/sync/stripe` _(auth: admin)_ — reconcile local DB against Stripe

## Stripe Integration

### Setting up webhooks (local dev)

```bash
# Install Stripe CLI
stripe listen --forward-to http://localhost:8787/webhooks/stripe
# Copy the displayed webhook signing secret into .dev.vars as STRIPE_WEBHOOK_SECRET
```

### Setting up webhooks (production)

1. In the Stripe Dashboard, create an endpoint pointing to `https://<your-worker>.workers.dev/webhooks/stripe`.
2. Subscribe to the events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`.
3. Copy the signing secret and push it to Cloudflare:

```bash
wrangler secret put STRIPE_WEBHOOK_SECRET
```

### Admin reconciliation

If products or customers fall out of sync (e.g. created before Stripe was integrated), run:

```bash
curl -X POST https://<host>/admin/sync/stripe \
  -H "Authorization: Bearer <admin-token>"
```

This creates missing Stripe Products/Prices and Stripe Customers, then updates the local DB with the returned IDs.

## Testing

```bash
bun test                          # all tests (uses local SQLite, no network)
bun test src/api/auth.test.ts     # single file
bun run test:coverage             # with coverage report
E2E=1 bun test test/e2e/          # end-to-end (requires running server)
```

## Generating OpenAPI Spec

```bash
bun scripts/gen-openapi.ts
# outputs: docs/openapi.json
```

## CI/CD

GitHub Actions workflows in `.github/workflows/`:
- `deploy-cloudflare.yml` — triggered on push to `main`; runs tests then deploys
- `deploy-vercel.yml` — triggered on push/PR to `main`; runs tests then deploys

Required GitHub Actions secrets:
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`
