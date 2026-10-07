PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_transaction_signer` (
	`privy_user_id` text PRIMARY KEY NOT NULL,
	`wallet_id` text NOT NULL,
	`wallet_address` text NOT NULL,
	`signer_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "transaction_signer_status" CHECK("status" in ('pending', 'enabled', 'disabled'))
);
--> statement-breakpoint
INSERT INTO `__new_transaction_signer`("privy_user_id", "wallet_id", "wallet_address", "signer_id", "policy_id", "status", "updated_at") SELECT "privy_user_id", "wallet_id", "wallet_address", "signer_id", "policy_id", "status", "updated_at" FROM `transaction_signer`;--> statement-breakpoint
DROP TABLE `transaction_signer`;--> statement-breakpoint
ALTER TABLE `__new_transaction_signer` RENAME TO `transaction_signer`;--> statement-breakpoint
PRAGMA foreign_keys=ON;