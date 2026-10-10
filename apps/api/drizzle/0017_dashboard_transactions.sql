CREATE TABLE `wallet_transfer` (
	`id` text PRIMARY KEY NOT NULL,
	`privy_user_id` text NOT NULL,
	`wallet` text NOT NULL,
	`direction` text NOT NULL,
	`network` text NOT NULL,
	`mint` text NOT NULL,
	`symbol` text,
	`decimals` integer NOT NULL,
	`amount_atomic` text NOT NULL,
	`counterparty` text NOT NULL,
	`signature` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`slot` text,
	`block_time` integer,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_transfer_signature` ON `wallet_transfer` (`privy_user_id`,`signature`,`mint`,`direction`);--> statement-breakpoint
CREATE INDEX `wallet_transfer_user_time` ON `wallet_transfer` (`privy_user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `wallet_transfer_user_counterparty` ON `wallet_transfer` (`privy_user_id`,`counterparty`);--> statement-breakpoint
ALTER TABLE `transaction_request` ADD `counterparty` text;--> statement-breakpoint
CREATE INDEX `transaction_request_user_time` ON `transaction_request` (`creator_user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `transaction_request_user_account` ON `transaction_request` (`creator_user_id`,`account`);--> statement-breakpoint
CREATE INDEX `transaction_request_user_counterparty` ON `transaction_request` (`creator_user_id`,`counterparty`);