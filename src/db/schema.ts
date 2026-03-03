/**
 * Drizzle ORM schema for the LOPC database.
 * Target: Turso (LibSQL / SQLite dialect).
 */
import { sql } from 'drizzle-orm';
import {
  integer,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

// ---- users ------------------------------------------------------------------

export const users = sqliteTable('users', {
  id:               text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  email:            text('email').notNull().unique(),
  passwordHash:     text('password_hash').notNull(),
  role:             text('role', { enum: ['customer', 'admin', 'inactive'] }).notNull().default('customer'),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt:        text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt:        text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// ---- customers --------------------------------------------------------------

export const customers = sqliteTable('customers', {
  id:        text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId:    text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  firstName: text('first_name').notNull(),
  lastName:  text('last_name').notNull(),
  phone:     text('phone'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

// ---- addresses --------------------------------------------------------------

export const addresses = sqliteTable('addresses', {
  id:         text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  customerId: text('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  type:       text('type', { enum: ['shipping', 'billing'] }).notNull().default('shipping'),
  street:     text('street').notNull(),
  city:       text('city').notNull(),
  state:      text('state'),
  postalCode: text('postal_code').notNull(),
  country:    text('country').notNull().default('US'),
  isDefault:  integer('is_default', { mode: 'boolean' }).notNull().default(false),
});

export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;

// ---- categories -------------------------------------------------------------

export const categories = sqliteTable('categories', {
  id:          text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  parentId:    text('parent_id'),  // self-reference handled at app level (no FK to avoid SQLite limitations)
  name:        text('name').notNull(),
  slug:        text('slug').notNull().unique(),
  description: text('description'),
  sortOrder:   integer('sort_order').notNull().default(0),
});

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;

// ---- products ---------------------------------------------------------------

export const products = sqliteTable('products', {
  id:              text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  categoryId:      text('category_id').references(() => categories.id, { onDelete: 'set null' }),
  name:            text('name').notNull(),
  slug:            text('slug').notNull().unique(),
  description:     text('description'),
  price:           real('price').notNull(),
  comparePrice:    real('compare_price'),
  stock:           integer('stock').notNull().default(0),
  status:          text('status', { enum: ['draft', 'active', 'archived'] }).notNull().default('draft'),
  stripeProductId: text('stripe_product_id'),
  stripePriceId:   text('stripe_price_id'),
  createdAt:       text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt:       text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

// ---- product_variants -------------------------------------------------------

export const productVariants = sqliteTable('product_variants', {
  id:        text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  productId: text('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  sku:       text('sku').notNull().unique(),
  name:      text('name').notNull(),
  price:     real('price'),           // null = inherit from product
  stock:     integer('stock').notNull().default(0),
  attributes: text('attributes'),     // JSON string: { color: "red", size: "L" }
});

export type ProductVariant = typeof productVariants.$inferSelect;
export type NewProductVariant = typeof productVariants.$inferInsert;

// ---- orders -----------------------------------------------------------------

export const orders = sqliteTable('orders', {
  id:           text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  customerId:   text('customer_id').notNull().references(() => customers.id),
  status:       text('status', {
    enum: ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
  }).notNull().default('pending'),
  subtotal:               real('subtotal').notNull(),
  tax:                    real('tax').notNull().default(0),
  shippingCost:           real('shipping_cost').notNull().default(0),
  total:                  real('total').notNull(),
  refundedAmount:         real('refunded_amount').notNull().default(0),
  notes:                  text('notes'),
  source:                 text('source', { enum: ['api', 'stripe'] }).notNull().default('api'),
  stripeSessionId:        text('stripe_session_id').unique(),
  stripePaymentIntentId:  text('stripe_payment_intent_id').unique(),
  shippingAddressId:      text('shipping_address_id').references(() => addresses.id),
  billingAddressId:       text('billing_address_id').references(() => addresses.id),
  createdAt:              text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt:              text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

// ---- order_lines ------------------------------------------------------------

export const orderLines = sqliteTable('order_lines', {
  id:            text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  orderId:       text('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  productId:     text('product_id').notNull().references(() => products.id),
  variantId:     text('variant_id').references(() => productVariants.id),
  quantity:      integer('quantity').notNull(),
  unitPrice:     real('unit_price').notNull(),
  lineTotal:     real('line_total').notNull(),
  stripePriceId: text('stripe_price_id'),
});

export type OrderLine = typeof orderLines.$inferSelect;
export type NewOrderLine = typeof orderLines.$inferInsert;

// ---- shipments --------------------------------------------------------------

export const shipments = sqliteTable('shipments', {
  id:             text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  orderId:        text('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  carrier:        text('carrier').notNull(),
  trackingNumber: text('tracking_number').notNull().unique(),
  status:         text('status', {
    enum: ['preparing', 'in_transit', 'out_for_delivery', 'delivered', 'failed'],
  }).notNull().default('preparing'),
  shippedAt:   text('shipped_at'),
  deliveredAt: text('delivered_at'),
});

export type Shipment = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;

// ---- stripe_order_import_staging -------------------------------------------

export const stripeOrderImportStaging = sqliteTable('stripe_order_import_staging', {
  id:                    text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  stripePaymentIntentId: text('stripe_payment_intent_id').notNull().unique(),
  stripeChargeId:        text('stripe_charge_id').notNull(),
  stripeCustomerId:      text('stripe_customer_id'),
  billingEmail:          text('billing_email'),
  amount:                real('amount').notNull(),
  amountRefunded:        real('amount_refunded').notNull().default(0),
  refunded:              integer('refunded').notNull().default(0),
  status:                text('status', { enum: ['pending', 'finalized', 'failed'] }).notNull().default('pending'),
  attempts:              integer('attempts').notNull().default(0),
  lastError:             text('last_error'),
  createdAt:             text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt:             text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export type StripeOrderImportStaging = typeof stripeOrderImportStaging.$inferSelect;
export type NewStripeOrderImportStaging = typeof stripeOrderImportStaging.$inferInsert;

// ---- refresh_tokens ---------------------------------------------------------
// Replaces the Upstash-based refresh token store.
// Tokens are rotated on every use; expired rows are cleaned up by the auth API.

export const refreshTokens = sqliteTable('refresh_tokens', {
  id:        text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId:    text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),                                    // SHA-256 hex of the opaque token
  type:      text('type', { enum: ['refresh', 'reset'] }).notNull().default('refresh'), // 'reset' = password reset token
  expiresAt: text('expires_at').notNull(),                                              // ISO-8601 datetime
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;

// ---- processed_webhook_events -----------------------------------------------
// Idempotency table for Stripe webhooks. Each processed event ID is stored here
// to prevent duplicate fulfillment on webhook retries.

export const processedWebhookEvents = sqliteTable('processed_webhook_events', {
  stripeEventId: text('stripe_event_id').primaryKey(),
  processedAt:   text('processed_at').notNull().default(sql`(datetime('now'))`),
});

export type ProcessedWebhookEvent = typeof processedWebhookEvents.$inferSelect;
export type NewProcessedWebhookEvent = typeof processedWebhookEvents.$inferInsert;
