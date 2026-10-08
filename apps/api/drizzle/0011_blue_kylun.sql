CREATE TABLE `transaction_link` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_name` text NOT NULL,
	`arguments_json` text NOT NULL,
	`network` text NOT NULL,
	`creator_user_id` text NOT NULL,
	`creator_client_id` text NOT NULL,
	`creator_grant_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`account` text,
	`candidate_json` text,
	`signature` text,
	`receipt_json` text,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_link_creator_request` ON `transaction_link` (`creator_user_id`,`creator_client_id`,`idempotency_key`);