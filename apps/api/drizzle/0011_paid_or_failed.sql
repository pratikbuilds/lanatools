-- Every call now ends paid or failed, decided by the endpoint's answer once
-- the payment is signed. Close the rows left in the removed states the same
-- way: a served call was paid, anything else failed and frees its hold.
UPDATE `payment_activity`
SET `status` = 'failed'
WHERE `status` = 'released';--> statement-breakpoint
UPDATE `payment_activity`
SET `status` = 'paid',
  `settled_atomic` = `reserved_atomic`,
  `error` = NULL,
  `completed_at` = coalesce(`completed_at`, `created_at`)
WHERE `status` = 'uncertain'
  AND `http_status` BETWEEN 200 AND 299;--> statement-breakpoint
UPDATE `payment_activity`
SET `status` = 'failed',
  `error` = 'The endpoint did not serve the call after the payment was signed, so it may have charged the wallet. It is not counted against the limit.',
  `completed_at` = coalesce(`completed_at`, `created_at`)
WHERE `status` = 'uncertain';--> statement-breakpoint
-- Reservations of calls that ended long ago, such as a stopped Worker.
UPDATE `payment_activity`
SET `status` = 'failed',
  `error` = CASE
    WHEN `payer_signature` IS NULL THEN 'The call ended before anything was signed'
    ELSE 'The call ended after the payment was signed, so it may have charged the wallet'
  END,
  `completed_at` = `created_at`
WHERE `status` = 'reserved'
  AND `created_at` < (unixepoch() * 1000) - 600000;
