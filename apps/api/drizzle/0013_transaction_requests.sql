ALTER TABLE `transaction_link` RENAME TO `transaction_request`;--> statement-breakpoint
ALTER TABLE `transaction_request` ADD `delivery` text DEFAULT 'link' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `transaction_link_creator_request`;--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_request_creator_request` ON `transaction_request` (`creator_user_id`,`creator_client_id`,`idempotency_key`);