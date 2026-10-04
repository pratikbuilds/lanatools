CREATE TABLE `tool_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`privy_user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`provider` text NOT NULL,
	`tool` text NOT NULL,
	`network` text,
	`status` text NOT NULL,
	`credits` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`duration_ms` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_activity_user_time` ON `tool_activity` (`privy_user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `tool_activity_user_client` ON `tool_activity` (`privy_user_id`,`client_id`);