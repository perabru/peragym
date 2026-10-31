CREATE TABLE `licenses` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `licenses_order` ON `licenses` (`order_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`price_cents` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`approved_at` integer,
	`approved_by` text,
	`bank_reference` text,
	`rejection_reason` text
);
--> statement-breakpoint
CREATE INDEX `orders_email_created` ON `orders` (`email`,`created_at`);--> statement-breakpoint
CREATE INDEX `orders_status_created` ON `orders` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_bank_reference_unique` ON `orders` (`bank_reference`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
