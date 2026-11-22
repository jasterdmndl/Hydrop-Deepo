-- Owner settlement for confirmed paid-and-delivered prior-day refills (DEC-048).
-- Stored separately from pos_sales so today's refill sales and closed day summaries stay intact.

ALTER TABLE pos_checkouts
  DROP CONSTRAINT IF EXISTS pos_checkouts_status_check;

ALTER TABLE pos_checkouts
  ADD CONSTRAINT pos_checkouts_status_check
  CHECK (status IN ('DRAFT', 'PAYMENT_PENDING', 'SAVED', 'REVIEW_REQUIRED', 'SETTLED_PRIOR_DAY', 'CANCELLED_DRAFT'));

CREATE TABLE pos_prior_day_settlements (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id                  uuid NOT NULL UNIQUE REFERENCES pos_checkouts (id),
  checkout_reference           text NOT NULL UNIQUE,
  original_business_day_id     uuid NOT NULL REFERENCES pos_business_days (id),
  original_business_date       date NOT NULL,
  settlement_date              date NOT NULL,
  outcome                      text NOT NULL CHECK (outcome IN ('PAID_AND_DELIVERED')),
  net_amount_kept_centavos     integer NOT NULL CHECK (net_amount_kept_centavos > 0),
  cash_received_centavos       integer CHECK (cash_received_centavos IS NULL OR cash_received_centavos >= net_amount_kept_centavos),
  change_centavos              integer CHECK (change_centavos IS NULL OR change_centavos >= 0),
  total_containers             integer NOT NULL CHECK (total_containers > 0),
  total_volume_ml              integer NOT NULL CHECK (total_volume_ml > 0),
  items_snapshot               jsonb NOT NULL,
  original_actor_user_id       uuid NOT NULL REFERENCES app_users (id),
  original_payment_recorded_at timestamptz,
  payment_kept_confirmed       boolean NOT NULL CHECK (payment_kept_confirmed = true),
  refill_delivered_confirmed   boolean NOT NULL CHECK (refill_delivered_confirmed = true),
  settled_by_user_id           uuid NOT NULL REFERENCES app_users (id),
  settled_at                   timestamptz NOT NULL,
  note                         text,
  CHECK (settlement_date > original_business_date),
  CHECK (
    (cash_received_centavos IS NULL AND change_centavos IS NULL)
    OR (cash_received_centavos IS NOT NULL AND change_centavos = cash_received_centavos - net_amount_kept_centavos)
  )
);

CREATE INDEX pos_prior_day_settlements_date_idx
  ON pos_prior_day_settlements (settlement_date DESC, settled_at DESC, checkout_reference DESC);

CREATE INDEX pos_prior_day_settlements_orig_date_idx
  ON pos_prior_day_settlements (original_business_date DESC, settled_at DESC);

