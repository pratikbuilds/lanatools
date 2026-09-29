ALTER TABLE `mcp_grant` ADD `scope` text DEFAULT 'account:read' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_grant` ADD `client_name` text;--> statement-breakpoint
ALTER TABLE `mcp_grant` ADD `redirect_uri` text;--> statement-breakpoint
ALTER TABLE `mcp_grant` ADD `activated_at` integer;--> statement-breakpoint
ALTER TABLE `mcp_grant` ADD `revoked_at` integer;--> statement-breakpoint
ALTER TABLE `mcp_grant` ADD `last_used_at` integer;