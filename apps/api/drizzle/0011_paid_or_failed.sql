-- Every call now ends paid or failed. A released row was freed because
-- nothing was signed or its payment never landed, so it failed. An endpoint
-- that served a call was paid. Other uncertain rows stay as they are: the
-- next call of their client checks the chain and closes them, as it does
-- for any written by a Worker from before this migration during the deploy.
UPDATE `payment_activity`
SET `status` = 'failed'
WHERE `status` = 'released';--> statement-breakpoint
UPDATE `payment_activity`
SET `status` = 'paid',
  `settled_atomic` = `reserved_atomic`,
  `error` = NULL,
  `completed_at` = coalesce(`completed_at`, `created_at`)
WHERE `status` = 'uncertain'
  AND `http_status` BETWEEN 200 AND 299;
