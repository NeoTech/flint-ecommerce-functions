# Admin

Admin-only endpoints for Stripe synchronization, data health, dashboard metrics, and reporting. All endpoints require a valid JWT with `role: admin`.

The Dashboard and Reports endpoints are served by the separately deployed `lopc-admin` Cloudflare Worker at a distinct URL; Sync and Data-Health endpoints are part of the main `lopc-api` Worker.

---

## POST /admin/sync/stripe

Bidirectional reconciliation between the local database and Stripe. Runs in phases to stay within Cloudflare's subrequest limits. The default `phase=all` runs all five steps sequentially.

**Auth:** `admin`

### Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `phase` | `string` | No | `all` (default), `catalog`, `stage`, `finalize`, or `status` |
| `batchSize` | `number` | No | Number of staged orders to finalize per call (default `3`, max `50`) |

### Phases

| Phase | Description |
|---|---|
| `all` | Stage Stripe charges **and** finalize in one call (may hit subrequest limits for large catalogs) |
| `catalog` | Sync products and customers only (Steps 1-4) — no charge import or finalization |
| `stage` | Import Stripe product/customer/charge data into local staging tables — no orders written yet. Pagination cursor is persisted in the `sync_cursors` table so staging is resumable across calls. |
| `finalize` | Convert staged rows into `orders` + `order_lines` in bounded batches (safe to call repeatedly) |
| `status` | Return backlog counts without any mutations |

### Response `200` — `phase=all`, `phase=catalog`, or `phase=finalize`

```json
{
  "data": {
    "phase": "all",
    "controls": {
      "finalizeBatch": 3,
      "cursorPersisted": true
    },
    "products": {
      "imported": 3,
      "created": 1,
      "synced": 2,
      "upToDate": 0,
      "archived": 1,
      "importedArchived": 0
    },
    "customers": {
      "imported": 5,
      "synced": 3,
      "created": 2,
      "upToDate": 0
    },
    "orders": {
      "staged": 10,
      "finalized": 3,
      "skipped": 7,
      "failed": 0,
      "backlog": {
        "pending": 7,
        "failed": 0,
        "finalized": 3,
        "staleProcessing": 0
      },
      "remainingToFinalize": 7
    }
  }
}
```

| Field | Description |
|---|---|
| `controls.finalizeBatch` | Batch size used for this call |
| `controls.cursorPersisted` | `true` if a Stripe pagination cursor was saved in `sync_cursors` for resumable staging |
| `products.archived` | Local products whose corresponding Stripe product is archived — status set to `archived` |
| `products.importedArchived` | Stripe archived products imported as new local rows with `status=archived` |
| `orders.backlog` | Counts by staging status: `pending`, `failed`, `finalized`, `staleProcessing` |
| `orders.backlog.staleProcessing` | Rows stuck in `processing` state for more than 5 minutes (lease expired — will be reclaimed on next finalize call) |
| `orders.remainingToFinalize` | `pending + failed + staleProcessing` — rows still awaiting finalization |

### Response `200` — `phase=status`

```json
{
  "data": {
    "phase": "status",
    "products": { "imported": 0, "created": 0, "synced": 0, "upToDate": 0, "archived": 0, "importedArchived": 0 },
    "customers": { "imported": 0, "synced": 0, "created": 0, "upToDate": 0 },
    "orders": {
      "staged": 0,
      "finalized": 0,
      "skipped": 0,
      "failed": 0,
      "backlog": {
        "pending": 7,
        "failed": 0,
        "finalized": 3,
        "staleProcessing": 0
      },
      "remainingToFinalize": 7
    }
  }
}
```

#### Sync Steps (phase=all/catalog/stage)

| Step | Runs in phase | Description |
|---|---|---|
| 1 | `all`, `catalog`, `stage` | Stripe active products → local DB (import missing, deduplicate slugs) |
| 1b | `all`, `catalog`, `stage` | Stripe archived products → archive matching local rows or import as `archived` |
| 2 | `all`, `catalog`, `stage` | Local products without Stripe IDs → Stripe (create Product + Price) |
| 3 | `all`, `catalog`, `stage` | Stripe customers → local DB (link `stripeCustomerId` for known emails, create guest rows for unknown) |
| 4 | `all`, `catalog`, `stage` | Local users without `stripeCustomerId` → Stripe (look up by email or create) |
| 5 | `all`, `stage` | Historical paid Stripe charges → `stripe_order_import_staging` table (cursor-based, resumable via `sync_cursors`) |

#### Finalize step

Reads rows from `stripe_order_import_staging` in batches. For each:
- Looks up Stripe Checkout Session line items
- Resolves or creates local product rows
- Upserts shipping/billing addresses
- Creates missing local customer profiles when checkout identity maps to an existing user without a customer row
- Backfills low-quality customer names (e.g. email/`-`) from Stripe checkout names when available
- Inserts `orders` + `order_lines`
- Preserves original transaction time (`orders.created_at` / `orders.updated_at` use Stripe charge `created` timestamp)
- Idempotent on `stripe_payment_intent_id`

### Webhook Gating

While a payment intent has a row in `stripe_order_import_staging` with status `pending` or `processing`, the webhook fulfillment handler (`POST /webhooks/stripe`) will **defer** processing and return early. This prevents race conditions where a Stripe webhook fires for a charge that is still being staged or finalized by admin sync. Once the staging row transitions to `finalized` or `failed`, webhooks are processed normally.

### Backfill Runbook

Safe operational sequence for a full historical backfill:

1. **`phase=catalog`** — Sync products and customers from Stripe without importing charges.
2. **`phase=stage`** — Stage all historical charges into `stripe_order_import_staging`. Resumable: the pagination cursor is persisted in `sync_cursors`, so you can repeat this call if it times out.
3. **`phase=finalize&batchSize=10`** — Convert staged rows into orders in bounded batches. Repeat until `remainingToFinalize=0`.
4. **Verify** — Call `phase=status` to confirm zero remaining, then `GET /admin/data-health` to check for orphans or stuck webhooks.

### Customer Name Repair Resync (existing historical imports)

If older imported orders have placeholder or email-style customer names, run this one-time repair sequence:

1. Delete only Stripe-import order artifacts (do **not** delete API-created orders):
  - `orders` where `source='stripe'`
  - all rows in `stripe_order_import_staging`
  - `sync_cursors` row with `id='stripe_charges'`
  - synthetic webhook rows (`processed_webhook_events` where `stripe_event_id` starts with `admin-sync:` for the deleted payment intents)
2. Run `phase=stage` once.
3. Run `phase=finalize` in a loop until `remainingToFinalize=0`.
4. If large batch finalize fails with `INTERNAL_ERROR`, switch to `batchSize=1` and continue looping until drained.
5. Verify representative repaired rows in DB (`customers.first_name`, `customers.last_name`) and run `phase=status`.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 400 | `BAD_REQUEST` | Invalid `phase` value |
| 500 | `SERVER_ERROR` | Unexpected error during sync |

---

## GET /admin/data-health

Read-only diagnostic snapshot of database state. Returns orphan counts, duplicate address groups, and orders that may be stuck in a failed webhook loop.

**Auth:** `admin`

### Response `200`

```json
{
  "data": {
    "tableCounts": {
      "users": 6,
      "customers": 4,
      "addresses": 6,
      "orders": 10,
      "orderLines": 11,
      "processedWebhookEvents": 1,
      "stripeOrderImportStaging": 0
    },
    "orphans": {
      "orderLinesNoOrder": 0,
      "shipmentsNoOrder": 0,
      "ordersWithMissingAddress": 0,
      "addressesUnreferencedByOrders": {
        "count": 0,
        "ids": []
      }
    },
    "duplicates": {
      "addressGroups": {
        "count": 0,
        "groups": []
      }
    },
    "webhooks": {
      "stuckOrders": {
        "count": 10,
        "items": [
          {
            "orderId": "uuid",
            "paymentIntentId": "pi_...",
            "sessionId": "cs_test_...",
            "total": 36
          }
        ]
      }
    }
  }
}
```

| Field | Description |
|---|---|
| `tableCounts` | Row counts for every major table |
| `orphans.orderLinesNoOrder` | Order lines whose parent order no longer exists |
| `orphans.shipmentsNoOrder` | Shipments whose parent order no longer exists |
| `orphans.ordersWithMissingAddress` | Orders referencing a non-existent address |
| `orphans.addressesUnreferencedByOrders` | Addresses not referenced by any order (may be intentional) |
| `duplicates.addressGroups` | Groups of identical addresses on the same customer |
| `webhooks.stuckOrders` | Stripe-source orders without a `processed_webhook_events` row (Stripe retries will 500 until resolved) |

---

## POST /admin/data-health

Mutation actions for resolving data-health issues. Specify the action via the `action` query parameter.

**Auth:** `admin`

### Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | `string` | Yes | `purge-orphans`, `dedupe-addresses`, `mark-webhook-processed`, or `rollback-order` |
| `eventId` | `string` | Conditional | Required when `action=mark-webhook-processed` |
| `paymentIntentId` | `string` | Conditional | Required when `action=rollback-order` |

---

### action=purge-orphans

Deletes all orphan rows in FK-safe order: `order_lines` → `shipments` → `orders` (missing address) → `addresses` (unreferenced) → `customers` (no orders, no addresses, not admin).

#### Response `200`

```json
{
  "data": {
    "action": "purge-orphans",
    "deleted": {
      "orderLines": 2,
      "shipments": 0,
      "orders": 0,
      "addresses": 3,
      "customers": 1
    }
  }
}
```

---

### action=dedupe-addresses

Removes exact duplicate address rows. For each duplicate group, the row referenced by an order is kept (or the lowest UUID if none are referenced). All others are deleted.

#### Response `200`

```json
{
  "data": {
    "action": "dedupe-addresses",
    "deleted": { "addresses": 2 },
    "deletedIds": ["uuid-1", "uuid-2"]
  }
}
```

---

### action=mark-webhook-processed

Inserts a Stripe event ID into `processed_webhook_events` so Stripe stops retrying the event (which would otherwise cause a 500 because the order already exists via admin sync).

#### Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `eventId` | `string` | Yes | Stripe event ID, e.g. `evt_1T6qXO5Rw...` |

#### Response `200`

```json
{
  "data": {
    "action": "mark-webhook-processed",
    "eventId": "evt_1T6qXO5Rw...",
    "alreadyPresent": false,
    "inserted": true
  }
}
```

| Field | Description |
|---|---|
| `inserted` | `true` if the row was newly inserted |
| `alreadyPresent` | `true` if the event was already recorded (idempotent) |

#### Error Responses

| Status | Code | Condition |
|---|---|---|
| 400 | `BAD_REQUEST` | Missing `eventId` |

---

### action=rollback-order

Deletes an order and all its lines by `stripePaymentIntentId`. Also removes the related `processed_webhook_events` row and `stripe_order_import_staging` row so the order can be cleanly re-imported by resending the Stripe event.

#### Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `paymentIntentId` | `string` | Yes | Stripe Payment Intent ID, e.g. `pi_3T6qXN5Rw...` |

#### Response `200`

```json
{
  "data": {
    "action": "rollback-order",
    "paymentIntentId": "pi_3T6qXN5Rw...",
    "orderId": "uuid",
    "deleted": {
      "order": true,
      "orderLines": true,
      "stagingRow": true,
      "processedWebhookEvent": true
    },
    "note": "Order and lines removed. You may now resend the Stripe webhook event to recreate this order."
  }
}
```

#### Error Responses

| Status | Code | Condition |
|---|---|---|
| 400 | `BAD_REQUEST` | Missing `paymentIntentId`, or no order found for that ID |

---

## GET /admin/dashboard

Returns today's summary metrics. Served by the `lopc-admin` Worker.

**Auth:** `admin`

### Response `200`

```json
{
  "data": {
    "ordersToday": 3,
    "revenueToday": 147.50,
    "newCustomersToday": 1,
    "lowStockProducts": [
      { "id": "uuid", "name": "Widget Pro", "stock": 2 }
    ]
  }
}
```

| Field | Type | Description |
|---|---|---|
| `ordersToday` | `number` | Orders created today (UTC) |
| `revenueToday` | `number` | Sum of `total` for non-cancelled/non-refunded orders today |
| `newCustomersToday` | `number` | New customer rows created today |
| `lowStockProducts` | `array` | Products with `stock < 10` (up to 20 results) |

---

## GET /admin/reports/sales

Daily revenue breakdown for a date range. Excludes cancelled and refunded orders.

**Auth:** `admin`

### Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `from` | `string` | Yes | Start date, `YYYY-MM-DD` |
| `to` | `string` | Yes | End date, `YYYY-MM-DD` (inclusive) |

### Response `200`

```json
{
  "data": {
    "from": "2025-01-01",
    "to": "2025-01-31",
    "totalOrders": 42,
    "totalRevenue": 2199.58,
    "avgOrderValue": 52.37,
    "daily": [
      { "date": "2025-01-01", "totalOrders": 3, "revenue": 149.97 }
    ]
  }
}
```

| Field | Type | Description |
|---|---|---|
| `totalOrders` | `number` | Orders in the range |
| `totalRevenue` | `number` | Sum of `total` in range |
| `avgOrderValue` | `number` | `totalRevenue / totalOrders` |
| `daily` | `array` | Day-by-day breakdown |

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 400 | `BAD_REQUEST` | Missing `from` or `to` |

---

## GET /admin/reports/inventory

Full product catalog with variants and stock levels.

**Auth:** `admin`

### Response `200`

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Widget Pro",
      "slug": "widget-pro",
      "price": 49.99,
      "stock": 8,
      "status": "active",
      "variants": [
        { "id": "uuid", "sku": "WP-L", "name": "Size: L", "stock": 3 }
      ]
    }
  ]
}
```

All product fields plus a `variants` array. See [products.md](./products.md) for full field definitions.

---

## GET /admin/reports/customers

Customer acquisition and activity summary.

**Auth:** `admin`

### Response `200`

```json
{
  "data": {
    "totalActive": 24,
    "totalInactive": 2,
    "newPerDay": [
      { "date": "2025-01-01", "count": 3 }
    ]
  }
}
```

| Field | Type | Description |
|---|---|---|
| `totalActive` | `number` | Users with `role = 'customer'` |
| `totalInactive` | `number` | Users with `role = 'inactive'` |
| `newPerDay` | `array` | New customer counts per day for the last 30 days |
