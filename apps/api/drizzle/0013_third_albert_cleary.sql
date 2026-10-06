CREATE TABLE `transaction_signer` (
	`privy_user_id` text PRIMARY KEY NOT NULL,
	`wallet_id` text NOT NULL,
	`wallet_address` text NOT NULL,
	`signer_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "transaction_signer_status" CHECK("transaction_signer"."status" in ('enabled', 'disabled'))
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_mcp_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`privy_user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`scope` text DEFAULT 'account:read' NOT NULL,
	`limit_micro_usd` integer DEFAULT 0 NOT NULL,
	`outgoing_allowed` integer DEFAULT false NOT NULL,
	`client_name` text,
	`redirect_uri` text,
	`created_at` integer NOT NULL,
	`activated_at` integer,
	`revoked_at` integer,
	`last_used_at` integer,
	CONSTRAINT "mcp_grant_outgoing_allowed" CHECK("outgoing_allowed" in (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_mcp_grant`("id", "privy_user_id", "client_id", "status", "scope", "limit_micro_usd", "outgoing_allowed", "client_name", "redirect_uri", "created_at", "activated_at", "revoked_at", "last_used_at") SELECT "id", "privy_user_id", "client_id", "status", "scope", "limit_micro_usd", 0, "client_name", "redirect_uri", "created_at", "activated_at", "revoked_at", "last_used_at" FROM `mcp_grant`;--> statement-breakpoint
DROP TABLE `mcp_grant`;--> statement-breakpoint
ALTER TABLE `__new_mcp_grant` RENAME TO `mcp_grant`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_grant_user_client` ON `mcp_grant` (`privy_user_id`,`client_id`);