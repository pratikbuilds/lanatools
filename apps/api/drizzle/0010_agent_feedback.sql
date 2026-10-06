CREATE TABLE `agent_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`privy_user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`feedback` text NOT NULL,
	`created_at` integer NOT NULL
);
