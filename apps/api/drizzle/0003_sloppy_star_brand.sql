CREATE TABLE `mcp_client` (
	`client_id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `mcp_grant` ADD `scope` text DEFAULT 'account:read' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_grant` ADD `activated_at` integer;--> statement-breakpoint
ALTER TABLE `mcp_grant` ADD `revoked_at` integer;--> statement-breakpoint
ALTER TABLE `mcp_grant` ADD `last_used_at` integer;