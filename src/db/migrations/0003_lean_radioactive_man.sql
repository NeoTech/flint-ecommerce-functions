CREATE TABLE `processed_webhook_events` (
	`stripe_event_id` text PRIMARY KEY NOT NULL,
	`processed_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `order_lines` ADD `stripe_price_id` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `source` text DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `stripe_session_id` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `stripe_payment_intent_id` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `shipping_address_id` text REFERENCES addresses(id);--> statement-breakpoint
ALTER TABLE `orders` ADD `billing_address_id` text REFERENCES addresses(id);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_stripe_session_id_unique` ON `orders` (`stripe_session_id`);--> statement-breakpoint
ALTER TABLE `products` ADD `stripe_product_id` text;--> statement-breakpoint
ALTER TABLE `products` ADD `stripe_price_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `stripe_customer_id` text;