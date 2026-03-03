# Database Schema Reference

Target: Turso (LibSQL/SQLite dialect) via Drizzle ORM.

All primary keys are UUID strings generated at insert time via `crypto.randomUUID()`. Timestamps are ISO-8601 strings in UTC using `datetime('now')` SQLite defaults.

---

## Table: users

Stores authentication credentials and role for every account.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `email` | TEXT | NOT NULL, UNIQUE | Login identifier |
| `password_hash` | TEXT | NOT NULL | bcrypt hash (cost 10) |
| `role` | TEXT | NOT NULL, DEFAULT `customer` | Enum: `customer`, `admin`, `inactive` |
| `stripe_customer_id` | TEXT | | Stripe Customer ID, set on first Stripe sync |
| `created_at` | TEXT | NOT NULL | ISO-8601 UTC |
| `updated_at` | TEXT | NOT NULL | ISO-8601 UTC |

---

## Table: customers

Profile data for users with the `customer` role.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `user_id` | TEXT | NOT NULL, FK → `users.id` CASCADE DELETE | One-to-one with users |
| `first_name` | TEXT | NOT NULL | |
| `last_name` | TEXT | NOT NULL | |
| `phone` | TEXT | | Optional |
| `created_at` | TEXT | NOT NULL | ISO-8601 UTC |

---

## Table: addresses

Shipping and billing addresses belonging to a customer.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `customer_id` | TEXT | NOT NULL, FK → `customers.id` CASCADE DELETE | |
| `type` | TEXT | NOT NULL, DEFAULT `shipping` | Enum: `shipping`, `billing` |
| `street` | TEXT | NOT NULL | |
| `city` | TEXT | NOT NULL | |
| `state` | TEXT | | Optional |
| `postal_code` | TEXT | NOT NULL | |
| `country` | TEXT | NOT NULL, DEFAULT `US` | ISO 3166-1 alpha-2 |
| `is_default` | INTEGER | NOT NULL, DEFAULT `0` | Boolean (0/1) |

---

## Table: categories

Product taxonomy. Supports unlimited nesting via `parent_id` (no FK constraint — handled at app level to avoid SQLite recursive FK limitations).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `parent_id` | TEXT | | Self-reference, no FK |
| `name` | TEXT | NOT NULL | |
| `slug` | TEXT | NOT NULL, UNIQUE | URL-safe identifier |
| `description` | TEXT | | Optional |
| `sort_order` | INTEGER | NOT NULL, DEFAULT `0` | Display ordering |

---

## Table: products

Purchasable items in the catalog.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `category_id` | TEXT | FK → `categories.id` SET NULL | Nullable |
| `name` | TEXT | NOT NULL | |
| `slug` | TEXT | NOT NULL, UNIQUE | URL-safe identifier |
| `description` | TEXT | | Optional |
| `price` | REAL | NOT NULL | Base price in store currency |
| `compare_price` | REAL | | Original/strikethrough price |
| `stock` | INTEGER | NOT NULL, DEFAULT `0` | Units in inventory |
| `status` | TEXT | NOT NULL, DEFAULT `draft` | Enum: `draft`, `active`, `archived` |
| `stripe_product_id` | TEXT | | Stripe Product ID, set after sync |
| `stripe_price_id` | TEXT | | Stripe Price ID for the base price |
| `created_at` | TEXT | NOT NULL | ISO-8601 UTC |
| `updated_at` | TEXT | NOT NULL | ISO-8601 UTC |

---

## Table: product_variants

Size/colour/style variants of a product. Each has its own SKU and optional price/stock override.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `product_id` | TEXT | NOT NULL, FK → `products.id` CASCADE DELETE | |
| `sku` | TEXT | NOT NULL, UNIQUE | Stock-keeping unit |
| `name` | TEXT | NOT NULL | Variant label (e.g. "Red / L") |
| `price` | REAL | | NULL = inherit from product |
| `stock` | INTEGER | NOT NULL, DEFAULT `0` | |
| `attributes` | TEXT | | JSON string, e.g. `{"color":"red","size":"L"}` |

---

## Table: orders

A customer's purchase transaction.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `customer_id` | TEXT | NOT NULL, FK → `customers.id` | No cascade — orders are retained |
| `status` | TEXT | NOT NULL, DEFAULT `pending` | Enum: `pending`, `confirmed`, `processing`, `shipped`, `delivered`, `cancelled`, `refunded` |
| `subtotal` | REAL | NOT NULL | Sum of line totals before tax/shipping |
| `tax` | REAL | NOT NULL, DEFAULT `0` | |
| `shipping_cost` | REAL | NOT NULL, DEFAULT `0` | |
| `total` | REAL | NOT NULL | subtotal + tax + shipping_cost |
| `refunded_amount` | REAL | NOT NULL, DEFAULT `0` | Cumulative refunds applied |
| `notes` | TEXT | | Internal notes |
| `source` | TEXT | NOT NULL, DEFAULT `api` | Enum: `api`, `stripe_import` — origin of the order |
| `stripe_session_id` | TEXT | UNIQUE | Stripe Checkout Session ID |
| `stripe_payment_intent_id` | TEXT | UNIQUE | Stripe Payment Intent ID |
| `shipping_address_id` | TEXT | FK → `addresses.id` | Nullable; selected shipping address |
| `billing_address_id` | TEXT | FK → `addresses.id` | Nullable; selected billing address |
| `created_at` | TEXT | NOT NULL | ISO-8601 UTC |
| `updated_at` | TEXT | NOT NULL | ISO-8601 UTC |

---

## Table: order_lines

Individual line items within an order.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `order_id` | TEXT | NOT NULL, FK → `orders.id` CASCADE DELETE | |
| `product_id` | TEXT | NOT NULL, FK → `products.id` | No cascade — product reference retained |
| `variant_id` | TEXT | FK → `product_variants.id` | Nullable — NULL if no variant |
| `quantity` | INTEGER | NOT NULL | |
| `unit_price` | REAL | NOT NULL | Price at time of purchase (snapshot) |
| `line_total` | REAL | NOT NULL | quantity × unit_price |
| `stripe_price_id` | TEXT | | Stripe Price ID snapshotted at order time |

---

## Table: shipments

Carrier shipment records linked to an order.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `order_id` | TEXT | NOT NULL, FK → `orders.id` CASCADE DELETE | |
| `carrier` | TEXT | NOT NULL | e.g. `UPS`, `FedEx`, `USPS` |
| `tracking_number` | TEXT | NOT NULL, UNIQUE | Carrier tracking code |
| `status` | TEXT | NOT NULL, DEFAULT `preparing` | Enum: `preparing`, `in_transit`, `out_for_delivery`, `delivered`, `failed` |
| `shipped_at` | TEXT | | ISO-8601 UTC, set when dispatched |
| `delivered_at` | TEXT | | ISO-8601 UTC, set on delivery confirmation |

---

## Table: processed_webhook_events

Idempotency log for Stripe webhook events. Prevents double-processing on retries.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `stripe_event_id` | TEXT | PRIMARY KEY | Stripe event ID (e.g. `evt_...`) |
| `processed_at` | TEXT | NOT NULL | ISO-8601 UTC |

---

## Table: stripe_order_import_staging

Two-phase import buffer for historical Stripe Payment Intents. Records move through this table before being committed as `orders`.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `stripe_payment_intent_id` | TEXT | NOT NULL, UNIQUE | Stripe PI ID |
| `stripe_charge_id` | TEXT | NOT NULL | Stripe Charge ID |
| `stripe_customer_id` | TEXT | | Stripe Customer ID (if known) |
| `billing_email` | TEXT | | Email from Stripe charge |
| `amount` | REAL | NOT NULL | Charge amount in store currency |
| `amount_refunded` | REAL | NOT NULL, DEFAULT `0` | Cumulative refunded amount |
| `refunded` | INTEGER | NOT NULL, DEFAULT `0` | Boolean (0/1) — fully refunded flag |
| `status` | TEXT | NOT NULL, DEFAULT `pending` | Enum: `pending`, `processing`, `finalized`, `failed` |
| `attempts` | INTEGER | NOT NULL, DEFAULT `0` | Processing attempt count |
| `last_error` | TEXT | | Last error message if failed |
| `claimed_at` | TEXT | | ISO-8601 UTC — set when a finalize batch claims this row |
| `claimed_by` | TEXT | | Unique claim ID for the finalize batch that owns this row |
| `created_at` | TEXT | NOT NULL | ISO-8601 UTC |
| `updated_at` | TEXT | NOT NULL | ISO-8601 UTC |

---

## Table: sync_cursors

Persisted high-water marks for deterministic Stripe sync pagination. Allows staging to resume across multiple calls without re-fetching already-processed pages.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | Logical cursor name (e.g. `stripe_charges`) |
| `cursor_type` | TEXT | NOT NULL | Type discriminator (e.g. `charge`) |
| `cursor_value` | TEXT | NOT NULL | Opaque Stripe cursor / object ID |
| `updated_at` | TEXT | NOT NULL | ISO-8601 UTC |

---

## Table: refresh_tokens

Opaque refresh and password-reset tokens. Tokens are rotated on every use.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `user_id` | TEXT | NOT NULL, FK → `users.id` CASCADE DELETE | |
| `token_hash` | TEXT | NOT NULL, UNIQUE | SHA-256 hex digest of the raw token |
| `type` | TEXT | NOT NULL, DEFAULT `refresh` | Enum: `refresh`, `reset` |
| `expires_at` | TEXT | NOT NULL | ISO-8601 UTC expiry |
| `created_at` | TEXT | NOT NULL | ISO-8601 UTC |

---

## FK Relationship Summary

```
users
  └── customers (user_id → users.id, CASCADE DELETE)
        └── addresses (customer_id → customers.id, CASCADE DELETE)
        └── orders (customer_id → customers.id)
              └── order_lines (order_id → orders.id, CASCADE DELETE)
              └── shipments (order_id → orders.id, CASCADE DELETE)
  └── refresh_tokens (user_id → users.id, CASCADE DELETE)

categories
  └── products (category_id → categories.id, SET NULL)
        └── product_variants (product_id → products.id, CASCADE DELETE)

products ← order_lines (product_id → products.id)
product_variants ← order_lines (variant_id → product_variants.id)

addresses ← orders (shipping_address_id → addresses.id)
addresses ← orders (billing_address_id → addresses.id)

processed_webhook_events  (standalone — no FKs)
stripe_order_import_staging  (standalone — no FKs)
sync_cursors  (standalone — no FKs)
```
