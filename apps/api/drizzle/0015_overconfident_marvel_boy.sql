CREATE TABLE `wallet_signer_removal` (
	`wallet_id` text PRIMARY KEY NOT NULL,
	`privy_user_id` text NOT NULL,
	`signer_id` text NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL
);
