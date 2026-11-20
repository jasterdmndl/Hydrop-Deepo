-- Durable payment-collection protection on POS checkouts (DEC-045).
-- Distinguishes an explicitly unpaid DRAFT from a PAYMENT_PENDING checkout
-- where staff have been instructed to receive cash.

ALTER TABLE pos_checkouts
  ADD COLUMN payment_started_at timestamptz;

ALTER TABLE pos_checkouts
  DROP CONSTRAINT IF EXISTS pos_checkouts_status_check;

ALTER TABLE pos_checkouts
  ADD CONSTRAINT pos_checkouts_status_check
  CHECK (status IN ('DRAFT', 'PAYMENT_PENDING', 'SAVED', 'REVIEW_REQUIRED', 'CANCELLED_DRAFT'));

ALTER TABLE pos_checkouts
  ADD CONSTRAINT pos_checkouts_payment_started_check
  CHECK (status <> 'PAYMENT_PENDING' OR payment_started_at IS NOT NULL);
