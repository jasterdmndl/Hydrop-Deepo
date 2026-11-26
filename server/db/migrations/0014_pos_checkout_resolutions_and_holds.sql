-- Final POS Task 1: verified checkout resolutions (DEC-095 through DEC-098)
-- and pre-sale inventory holds (DEC-103, INV-015, DEC-067 RLS).

ALTER TABLE pos_checkouts
  DROP CONSTRAINT IF EXISTS pos_checkouts_status_check;

ALTER TABLE pos_checkouts
  ADD CONSTRAINT pos_checkouts_status_check
  CHECK (
    status IN (
      'DRAFT',
      'PAYMENT_PENDING',
      'SAVED',
      'REVIEW_REQUIRED',
      'SETTLED_PRIOR_DAY',
      'CANCELLED_DRAFT',
      'CANCELLED_NO_CASH',
      'REFUNDED_UNSAVED'
    )
  );

ALTER TABLE pos_prior_day_settlements
  ADD COLUMN IF NOT EXISTS items_handed_over_confirmed boolean NOT NULL DEFAULT false;

UPDATE pos_prior_day_settlements
   SET items_handed_over_confirmed = true
 WHERE items_snapshot::text LIKE '%"MERCHANDISE"%'
    OR items_snapshot::text LIKE '%"CONTAINER_PACKAGE"%';

CREATE TABLE pos_checkout_resolutions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id              uuid NOT NULL UNIQUE REFERENCES pos_checkouts (id),
  checkout_reference       text NOT NULL UNIQUE,
  original_business_day_id uuid NOT NULL REFERENCES pos_business_days (id),
  original_business_date   date NOT NULL,
  resolution_date          date NOT NULL,
  outcome                  text NOT NULL CHECK (outcome IN ('NO_CASH_CANCELLED', 'FULL_REFUND')),
  quote_total_centavos     integer NOT NULL CHECK (quote_total_centavos > 0),
  cash_received_centavos   integer CHECK (cash_received_centavos IS NULL OR cash_received_centavos > 0),
  change_already_given     boolean,
  change_given_centavos    integer CHECK (change_given_centavos IS NULL OR change_given_centavos >= 0),
  refunded_amount_centavos integer CHECK (refunded_amount_centavos IS NULL OR refunded_amount_centavos > 0),
  items_snapshot           jsonb NOT NULL,
  original_actor_user_id   uuid NOT NULL REFERENCES app_users (id),
  resolved_by_user_id      uuid NOT NULL REFERENCES app_users (id),
  resolved_at              timestamptz NOT NULL,
  reason                   text NOT NULL,
  note                     text,
  CHECK (
    (
      outcome = 'NO_CASH_CANCELLED'
      AND resolution_date > original_business_date
      AND cash_received_centavos IS NULL
      AND change_already_given IS NULL
      AND change_given_centavos IS NULL
      AND refunded_amount_centavos IS NULL
    )
    OR (
      outcome = 'FULL_REFUND'
      AND resolution_date >= original_business_date
      AND cash_received_centavos IS NOT NULL
      AND change_already_given IS NOT NULL
      AND change_given_centavos IS NOT NULL
      AND refunded_amount_centavos IS NOT NULL
      AND refunded_amount_centavos = cash_received_centavos - change_given_centavos
      AND (
        (change_already_given = false AND change_given_centavos = 0)
        OR (
          change_already_given = true
          AND cash_received_centavos >= quote_total_centavos
          AND change_given_centavos = cash_received_centavos - quote_total_centavos
        )
      )
    )
  )
);

CREATE INDEX pos_checkout_resolutions_date_idx
  ON pos_checkout_resolutions (resolution_date DESC, resolved_at DESC, checkout_reference DESC);

ALTER TABLE pos_checkout_resolutions ENABLE ROW LEVEL SECURITY;

CREATE TABLE inventory_stock_holds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id              uuid NOT NULL REFERENCES inventory_items (id),
  quantity             integer NOT NULL CHECK (quantity > 0),
  unit                 text NOT NULL,
  reason               text NOT NULL,
  source_kind          text NOT NULL CHECK (source_kind IN ('CHECKOUT_REFUND', 'CHECKOUT_CANCEL', 'SALE_ACTION')),
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED', 'DISPOSED')),
  reduces_availability boolean NOT NULL DEFAULT true,
  checkout_id          uuid REFERENCES pos_checkouts (id),
  resolution_id        uuid REFERENCES pos_checkout_resolutions (id),
  pos_sale_id          uuid REFERENCES pos_sales (id),
  pos_reference        text NOT NULL,
  actor_user_id        uuid NOT NULL REFERENCES app_users (id),
  recorded_at          timestamptz NOT NULL,
  resolved_at          timestamptz,
  CHECK (
    (source_kind = 'CHECKOUT_REFUND' AND checkout_id IS NOT NULL AND resolution_id IS NOT NULL AND pos_sale_id IS NULL)
    OR (source_kind = 'CHECKOUT_CANCEL' AND checkout_id IS NOT NULL AND pos_sale_id IS NULL)
    OR (source_kind = 'SALE_ACTION' AND pos_sale_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX inventory_stock_holds_checkout_item_uidx
  ON inventory_stock_holds (checkout_id, item_id)
  WHERE checkout_id IS NOT NULL;

CREATE INDEX inventory_stock_holds_active_item_idx
  ON inventory_stock_holds (item_id)
  WHERE status = 'ACTIVE';

ALTER TABLE inventory_stock_holds ENABLE ROW LEVEL SECURITY;
