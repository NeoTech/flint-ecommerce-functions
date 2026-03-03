-- Add unique index on products.stripe_product_id (partial — NULL values excluded)
CREATE UNIQUE INDEX IF NOT EXISTS `products_stripe_product_id_unique` ON `products` (`stripe_product_id`) WHERE `stripe_product_id` IS NOT NULL;
--> statement-breakpoint
-- Add lease columns to stripe_order_import_staging for claim-based finalize
ALTER TABLE `stripe_order_import_staging` ADD COLUMN `claimed_at` text DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `stripe_order_import_staging` ADD COLUMN `claimed_by` text DEFAULT NULL;
--> statement-breakpoint
-- Sync cursor persistence table
CREATE TABLE IF NOT EXISTS `sync_cursors` (
  `id` text PRIMARY KEY NOT NULL,
  `cursor_type` text NOT NULL,
  `cursor_value` text NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL
);
