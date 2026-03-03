# Common Commands

## Variables

Set these once in your shell session — all commands below use them.

```bash
API=https://lopc-api.andreas-016.workers.dev
LOCAL=http://localhost:8787
```

---

## Dev server

```bash
bun run dev:bun          # start local server on :8787
bun run test             # run all tests
bun run build            # bundle for CF Workers
bun run deploy:cf        # deploy to Cloudflare Workers
```

---

## Authentication

### Get an admin token (login)

```bash
TOKEN=$(curl -s -X POST $API/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"your-password"}' \
  | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

echo $TOKEN   # verify it printed
```

### Register a new customer account

```bash
curl -X POST $API/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123","firstName":"Jane","lastName":"Doe"}'
```

### Refresh an expired access token

```bash
curl -X POST $API/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<refresh-token>"}'
```

---

## Products

### List active products

```bash
curl $API/products
```

### List all products including drafts (admin)

```bash
curl "$API/products?status=draft" -H "Authorization: Bearer $TOKEN"
```

### Create a product

```bash
curl -X POST $API/products \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Widget Pro","price":49.99,"stock":100,"status":"active"}'
```

### Update a product

```bash
curl -X PUT $API/products/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"price":59.99}'
```

### Delete (archive) a product

```bash
curl -X DELETE $API/products/<id> -H "Authorization: Bearer $TOKEN"
```

---

## Orders

### List orders (admin)

```bash
curl $API/orders -H "Authorization: Bearer $TOKEN"
```

### Get a single order

```bash
curl $API/orders/<id> -H "Authorization: Bearer $TOKEN"
```

### Create an order manually (API source)

```bash
curl -X POST $API/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "<customer-id>",
    "lines": [{"productId":"<product-id>","quantity":2}]
  }'
```

### Update order status

```bash
curl -X PUT $API/orders/<id>/status \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"confirmed"}'
```

---

## Customers

### List customers (admin)

```bash
curl $API/customers -H "Authorization: Bearer $TOKEN"
```

### Get a customer

```bash
curl $API/customers/<id> -H "Authorization: Bearer $TOKEN"
```

---

## Stripe

### Sync local DB to Stripe (creates missing products/customers in Stripe)

```bash
curl -X POST $API/admin/sync/stripe -H "Authorization: Bearer $TOKEN"
```

### Register webhook in Stripe Dashboard

Endpoint URL:
```
https://lopc-api.andreas-016.workers.dev/webhooks/stripe
```
Events to subscribe: `checkout.session.completed`, `checkout.session.async_payment_succeeded`

### Push webhook secret to Cloudflare after registering

```bash
wrangler secret put STRIPE_WEBHOOK_SECRET
```

### Test webhook locally with Stripe CLI

```bash
stripe listen --forward-to http://localhost:8787/webhooks/stripe
stripe trigger checkout.session.completed   # in a second terminal
```

---

## Database

```bash
bun run db:generate   # generate migration from schema changes
bun run db:migrate    # apply migrations to Turso
```

---

## Bootstrap first admin (one-time, requires BOOTSTRAP_SECRET in env)

```bash
curl -X POST $API/auth/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"your-password","secret":"<BOOTSTRAP_SECRET>"}'
```

Remove `BOOTSTRAP_SECRET` from `wrangler.toml` and redeploy after this is done.
