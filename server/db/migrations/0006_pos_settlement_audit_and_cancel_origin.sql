-- Additive schema updates for DEC-048 retest findings:
-- 1) Record original payment start time separately from payment recording time.
-- 2) Distinguish server-assigned explicit cancellations from automatic End Day draft clears.

ALTER TABLE pos_prior_day_settlements
  ADD COLUMN IF NOT EXISTS original_payment_started_at timestamptz;

ALTER TABLE pos_checkouts
  ADD COLUMN IF NOT EXISTS cancellation_origin text;

ALTER TABLE pos_checkouts
  DROP CONSTRAINT IF EXISTS pos_checkouts_cancellation_origin_check;

ALTER TABLE pos_checkouts
  ADD CONSTRAINT pos_checkouts_cancellation_origin_check
  CHECK (cancellation_origin IS NULL OR cancellation_origin IN ('EXPLICIT_OPERATOR', 'AUTO_END_DAY'));
