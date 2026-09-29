CREATE TABLE `mcp_consent` (
	`handle` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`privy_user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_grant_user_client` ON `mcp_grant` (`privy_user_id`,`client_id`);