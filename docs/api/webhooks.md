# Webhooks

Stripe webhook ingestion endpoint. Not for direct client use — Stripe calls this automatically when events occur.

---

## POST /webhooks/stripe

Receives Stripe webhook events and fulfills orders automatically. Handles:
- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

Uses `stripe-signature` header verification (HMAC-SHA256) to authenticate events. Reads the raw body as bytes before parsing — required by Stripe's signature algorithm.

Idempotency is enforced via the `processed_webhook_events` table. Duplicate event IDs are silently no-ops.

Only fulfills sessions where `payment_status !== 'unpaid'` (prevents fulfillment of pending async payments before confirmation).

**Auth:** `none` (verified by Stripe signature)

### Request Headers

| Header | Required | Description |
|---|---|---|
| `stripe-signature` | Yes | Stripe webhook signature (HMAC-SHA256) |
| `Content-Type` | Yes | `application/json` |

### Request Body

Raw Stripe event JSON (do not modify before forwarding).

```json
{
  "id": "evt_1T6qXO5RwVcf7QBBVnxif6kp",
  "type": "checkout.session.completed",
  "data": {
    "object": {
      "id": "cs_test_...",
      "payment_status": "paid",
      "payment_intent": "pi_...",
      "customer": "cus_...",
      "shipping_details": { ... },
      "customer_details": { ... }
    }
  }
}
```

### Response `200`

```json
{
  "data": { "received": true },
  "meta": null,
  "error": null
}
```

Events of types other than the two handled types are acknowledged with `{ "received": true }` and ignored.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 400 | `BAD_REQUEST` | Missing `stripe-signature` header |
| 400 | `BAD_REQUEST` | Signature verification failed (tampered body or wrong secret) |

### Fulfillment Behavior on Success

When a valid `checkout.session.completed` event arrives:

1. Idempotency check — if `event.id` already in `processed_webhook_events`, skip
2. Expand line items via `stripe.checkout.sessions.listLineItems(sessionId)`
3. Upsert shipping address from `session.shipping_details`
4. Upsert billing address from `session.customer_details`
5. Create guest user + customer row if the email has no existing account
6. Insert `orders` + `order_lines` in a single DB transaction
7. Mark event processed in `processed_webhook_events`

### Webhook Registration

Register the endpoint in the Stripe Dashboard under:
**Developers → Webhooks → Add endpoint**

```
https://lopc-api.andreas-016.workers.dev/webhooks/stripe
```

Listen for:
- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
