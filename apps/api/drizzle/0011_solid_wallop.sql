CREATE TABLE `transaction_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`number` integer NOT NULL,
	`state` text NOT NULL,
	`claim_token` text NOT NULL,
	`wallet_address` text NOT NULL,
	`network` text NOT NULL,
	`message_base64` text,
	`message_hash` text,
	`preparation_slot` text,
	`blockhash` text,
	`last_valid_block_height` text,
	`signed_base64` text,
	`signature` text,
	`evidence` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `transaction_request`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transaction_attempt_number_positive" CHECK("transaction_attempt"."number" > 0),
	CONSTRAINT "transaction_attempt_state" CHECK("transaction_attempt"."state" in ('preparing', 'prepared', 'issued', 'signing', 'signed', 'submitting', 'submitted', 'uncertain', 'succeeded', 'failed', 'expired', 'abandoned')),
	CONSTRAINT "transaction_attempt_network" CHECK("transaction_attempt"."network" in ('devnet', 'mainnet')),
	CONSTRAINT "transaction_attempt_prepared" CHECK("transaction_attempt"."state" in ('preparing', 'abandoned') or ("transaction_attempt"."message_base64" is not null and "transaction_attempt"."message_hash" is not null and "transaction_attempt"."preparation_slot" is not null and "transaction_attempt"."blockhash" is not null and "transaction_attempt"."last_valid_block_height" is not null)),
	CONSTRAINT "transaction_attempt_signed" CHECK("transaction_attempt"."state" not in ('signed', 'submitting', 'submitted') or ("transaction_attempt"."signed_base64" is not null and "transaction_attempt"."signature" is not null)),
	CONSTRAINT "transaction_attempt_evidence" CHECK("transaction_attempt"."state" not in ('submitted', 'uncertain', 'succeeded', 'failed', 'expired') or "transaction_attempt"."evidence" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_attempt_number` ON `transaction_attempt` (`request_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_attempt_one_active` ON `transaction_attempt` (`request_id`) WHERE "transaction_attempt"."state" in ('preparing', 'prepared', 'issued', 'signing', 'signed', 'submitting', 'submitted', 'uncertain');--> statement-breakpoint
CREATE TABLE `transaction_request` (
	`id` text PRIMARY KEY NOT NULL,
	`privy_user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`originating_grant_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`canonical_input` text NOT NULL,
	`input_hash` text NOT NULL,
	`execution` text NOT NULL,
	`network` text NOT NULL,
	`wallet_address` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`refusal` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "transaction_request_execution" CHECK("transaction_request"."execution" in ('embedded', 'external')),
	CONSTRAINT "transaction_request_network" CHECK("transaction_request"."network" in ('devnet', 'mainnet')),
	CONSTRAINT "transaction_request_status" CHECK("transaction_request"."status" in ('pending', 'refused')),
	CONSTRAINT "transaction_request_wallet" CHECK("transaction_request"."execution" = 'external' or "transaction_request"."wallet_address" is not null),
	CONSTRAINT "transaction_request_refusal" CHECK(("transaction_request"."status" = 'pending' and "transaction_request"."refusal" is null) or ("transaction_request"."status" = 'refused' and "transaction_request"."refusal" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_request_user_client_key` ON `transaction_request` (`privy_user_id`,`client_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `transaction_request_user_time` ON `transaction_request` (`privy_user_id`,`created_at`);