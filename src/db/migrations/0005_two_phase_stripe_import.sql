CREATE TABLE `stripe_order_import_staging` (
	`id` text PRIMARY KEY NOT NULL,
	`stripe_payment_intent_id` text NOT NULL,
	`stripe_charge_id` text NOT NULL,
	`stripe_customer_id` text,
	`billing_email` text,
	`amount` real NOT NULL,
	`amount_refunded` real DEFAULT 0 NOT NULL,
	`refunded` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_order_import_staging_pi_unique` ON `stripe_order_import_staging` (`stripe_payment_intent_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_stripe_payment_intent_id_unique` ON `orders` (`stripe_payment_intent_id`);
