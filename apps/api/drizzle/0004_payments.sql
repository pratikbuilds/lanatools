CREATE TABLE `payment_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`privy_user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`method` text NOT NULL,
	`origin` text NOT NULL,
	`path` text NOT NULL,
	`protocol` text,
	`status` text NOT NULL,
	`network` text,
	`mint` text,
	`reserved_atomic` integer DEFAULT 0 NOT NULL,
	`settled_atomic` integer,
	`signature` text,
	`http_status` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `payment_activity_user_client` ON `payment_activity` (`privy_user_id`,`client_id`,`status`);--> statement-breakpoint
CREATE TABLE `payment_signer` (
	`privy_user_id` text PRIMARY KEY NOT NULL,
	`wallet_id` text NOT NULL,
	`wallet_address` text NOT NULL,
	`policy_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `mcp_grant` ADD `limit_micro_usd` integer DEFAULT 0 NOT NULL;