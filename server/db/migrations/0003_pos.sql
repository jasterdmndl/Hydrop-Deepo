-- Refill-only POS catalog, station business days, checkouts, and immutable sales
-- (DEC-043, DAY-001, DAY-002, POS-002, POS-003, POS-006 through POS-008).

CREATE TABLE pos_refill_catalog (
  code                 text PRIMARY KEY,
  water_type           text NOT NULL CHECK (water_type IN ('PURIFIED', 'ALKALINE')),
  display_name         text NOT NULL,
  unit_volume_ml       integer NOT NULL CHECK (unit_volume_ml > 0),
  unit_price_centavos  integer NOT NULL CHECK (unit_price_centavos > 0),
  active               boolean NOT NULL DEFAULT true,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

INSERT INTO pos_refill_catalog (code, water_type, display_name, unit_volume_ml, unit_price_centavos)
VALUES
  ('PURIFIED_25L', 'PURIFIED', 'Purified refill · 25 L', 25000, 2500),
  ('ALKALINE_25L', 'ALKALINE', 'Alkaline refill · 25 L', 25000, 3500);

CREATE TABLE pos_business_days (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date                date NOT NULL UNIQUE,
  started_by_user_id           uuid NOT NULL REFERENCES app_users (id),
  started_at                   timestamptz NOT NULL,
  start_request_key            text UNIQUE,
  closed_by_user_id            uuid REFERENCES app_users (id),
  closed_at                    timestamptz,
  close_request_key            text UNIQUE,
  closed_total_sales_centavos  integer CHECK (closed_total_sales_centavos IS NULL OR closed_total_sales_centavos >= 0),
  closed_valid_tx_count        integer CHECK (closed_valid_tx_count IS NULL OR closed_valid_tx_count >= 0),
  closed_purified_qty          integer CHECK (closed_purified_qty IS NULL OR closed_purified_qty >= 0),
  closed_alkaline_qty          integer CHECK (closed_alkaline_qty IS NULL OR closed_alkaline_qty >= 0),
  closed_purified_volume_ml    integer CHECK (closed_purified_volume_ml IS NULL OR closed_purified_volume_ml >= 0),
  closed_alkaline_volume_ml    integer CHECK (closed_alkaline_volume_ml IS NULL OR closed_alkaline_volume_ml >= 0),
  closed_voided_count          integer CHECK (closed_voided_count IS NULL OR closed_voided_count >= 0),
  closed_voided_total_centavos integer CHECK (closed_voided_total_centavos IS NULL OR closed_voided_total_centavos >= 0),
  next_reference_seq           integer NOT NULL DEFAULT 0 CHECK (next_reference_seq >= 0),
  CHECK ((closed_at IS NULL AND closed_by_user_id IS NULL) OR (closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL)),
  CHECK (
    (
      closed_at IS NULL
      AND closed_total_sales_centavos IS NULL
      AND closed_valid_tx_count IS NULL
      AND closed_purified_qty IS NULL
      AND closed_alkaline_qty IS NULL
      AND closed_purified_volume_ml IS NULL
      AND closed_alkaline_volume_ml IS NULL
      AND closed_voided_count IS NULL
      AND closed_voided_total_centavos IS NULL
    )
    OR (
      closed_at IS NOT NULL
      AND closed_total_sales_centavos IS NOT NULL
      AND closed_valid_tx_count IS NOT NULL
      AND closed_purified_qty IS NOT NULL
      AND closed_alkaline_qty IS NOT NULL
      AND closed_purified_volume_ml IS NOT NULL
      AND closed_alkaline_volume_ml IS NOT NULL
      AND closed_voided_count IS NOT NULL
      AND closed_voided_total_centavos IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX pos_business_days_single_open_idx
  ON pos_business_days ((1))
  WHERE closed_at IS NULL;

CREATE TABLE pos_checkouts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference               text NOT NULL UNIQUE,
  prepare_key             text UNIQUE,
  business_day_id         uuid NOT NULL REFERENCES pos_business_days (id),
  business_date           date NOT NULL,
  created_by_user_id      uuid NOT NULL REFERENCES app_users (id),
  status                  text NOT NULL CHECK (status IN ('DRAFT', 'SAVED', 'REVIEW_REQUIRED', 'CANCELLED_DRAFT')),
  quote_snapshot          jsonb NOT NULL,
  quote_hash              text NOT NULL,
  total_centavos          integer NOT NULL CHECK (total_centavos > 0),
  total_containers        integer NOT NULL CHECK (total_containers > 0),
  total_volume_ml         integer NOT NULL CHECK (total_volume_ml > 0),
  cash_received_centavos  integer CHECK (cash_received_centavos IS NULL OR cash_received_centavos >= total_centavos),
  change_centavos         integer CHECK (change_centavos IS NULL OR change_centavos >= 0),
  payment_recorded_at     timestamptz,
  resolution_reason       text,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  CHECK (
    (cash_received_centavos IS NULL AND change_centavos IS NULL)
    OR (cash_received_centavos IS NOT NULL AND change_centavos = cash_received_centavos - total_centavos)
  )
);

CREATE INDEX pos_checkouts_day_status_idx
  ON pos_checkouts (business_day_id, status, created_at);

CREATE TABLE pos_sales (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference               text NOT NULL UNIQUE,
  checkout_id             uuid NOT NULL UNIQUE REFERENCES pos_checkouts (id),
  business_day_id         uuid NOT NULL REFERENCES pos_business_days (id),
  business_date           date NOT NULL,
  status                  text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'VOIDED')),
  total_centavos          integer NOT NULL CHECK (total_centavos > 0),
  cash_received_centavos  integer NOT NULL CHECK (cash_received_centavos >= total_centavos),
  change_centavos         integer NOT NULL CHECK (change_centavos = cash_received_centavos - total_centavos),
  total_containers        integer NOT NULL CHECK (total_containers > 0),
  total_volume_ml         integer NOT NULL CHECK (total_volume_ml > 0),
  created_by_user_id      uuid NOT NULL REFERENCES app_users (id),
  created_at              timestamptz NOT NULL
);

CREATE INDEX pos_sales_business_date_created_idx
  ON pos_sales (business_date DESC, created_at DESC, reference DESC);

CREATE INDEX pos_sales_day_status_idx
  ON pos_sales (business_day_id, status);

CREATE TABLE pos_sale_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id              uuid NOT NULL REFERENCES pos_sales (id),
  line_index           integer NOT NULL CHECK (line_index >= 0),
  item_kind            text NOT NULL CHECK (item_kind IN ('STANDARD', 'CUSTOM')),
  catalog_code         text REFERENCES pos_refill_catalog (code),
  water_type           text NOT NULL CHECK (water_type IN ('PURIFIED', 'ALKALINE')),
  display_label        text NOT NULL,
  unit_volume_ml       integer NOT NULL CHECK (unit_volume_ml > 0),
  unit_price_centavos  integer NOT NULL CHECK (unit_price_centavos > 0),
  quantity             integer NOT NULL CHECK (quantity > 0),
  line_total_centavos  integer NOT NULL CHECK (line_total_centavos = unit_price_centavos * quantity),
  line_volume_ml       integer NOT NULL CHECK (line_volume_ml = unit_volume_ml * quantity),
  UNIQUE (sale_id, line_index)
);

CREATE TABLE pos_sale_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id      uuid NOT NULL REFERENCES pos_sales (id),
  action       text NOT NULL CHECK (action IN ('SALE_SAVED', 'SALE_VOIDED')),
  actor_user_id uuid NOT NULL REFERENCES app_users (id),
  note         text,
  recorded_at  timestamptz NOT NULL
);

CREATE INDEX pos_sale_actions_sale_idx
  ON pos_sale_actions (sale_id, recorded_at ASC);
