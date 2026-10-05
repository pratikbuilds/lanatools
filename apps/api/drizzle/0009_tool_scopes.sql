ALTER TABLE `mcp_consent` DROP COLUMN `scope`;--> statement-breakpoint
-- Grants made before per-family scopes carry the old scopes. There are no
-- users yet, so clients reconnect and choose their tools again, and their
-- payment and tool-call history goes with them.
DELETE FROM `mcp_grant`;--> statement-breakpoint
DELETE FROM `payment_activity`;--> statement-breakpoint
DELETE FROM `tool_activity`;
