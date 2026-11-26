-- Final POS Task 2: durable Owner sale actions (POS-004, POS-005, DEC-099, DEC-106)
-- and linked replacement sales with DEC-067 row-level security.

ALTER TABLE pos_sales
  ALTER COLUMN checkout_id DROP NOT NULL;

ALTER TABLE pos_sales
  ADD COLUMN IF NOT EXISTS corrected_from_sale_id uuid UNIQUE REFERENCES pos_sales (id);

ALTER TABLE pos_sales
  DROP CONSTRAINT IF EXISTS pos_sales_origin_check;

ALTER TABLE pos_sales
  ADD CONSTRAINT pos_sales_origin_check
  CHECK (checkout_id IS NOT NULL OR corrected_from_sale_id IS NOT NULL);

ALTER TABLE pos_business_days
  ADD COLUMN IF NOT EXISTS next_action_seq integer NOT NULL DEFAULT 0 CHECK (next_action_seq >= 0);

CREATE TABLE pos_sale_action_requests (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference                      text NOT NULL UNIQUE,
  prepare_key                    text UNIQUE,
  original_sale_id               uuid NOT NULL REFERENCES pos_sales (id),
  original_sale_reference        text NOT NULL,
  original_business_day_id       uuid NOT NULL REFERENCES pos_business_days (id),
  original_business_date         date NOT NULL,
  action_type                    text NOT NULL CHECK (action_type IN ('VOID', 'CORRECT')),
  status                         text NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED_NO_CASH')),
  reason                         text NOT NULL,
  original_total_centavos        integer NOT NULL CHECK (original_total_centavos > 0),
  original_cash_received_centavos integer NOT NULL CHECK (original_cash_received_centavos >= original_total_centavos),
  original_change_centavos       integer NOT NULL CHECK (original_change_centavos = original_cash_received_centavos - original_total_centavos),
  corrected_total_centavos       integer NOT NULL CHECK (corrected_total_centavos >= 0),
  cash_difference_centavos       integer NOT NULL CHECK (cash_difference_centavos = corrected_total_centavos - original_total_centavos),
  corrected_items_snapshot       jsonb,
  merchandise_plan               jsonb NOT NULL DEFAULT '{}'::jsonb,
  cash_tendered_centavos         integer CHECK (cash_tendered_centavos IS NULL OR cash_tendered_centavos >= 0),
  cash_change_centavos           integer CHECK (cash_change_centavos IS NULL OR cash_change_centavos >= 0),
  cash_refunded_centavos         integer CHECK (cash_refunded_centavos IS NULL OR cash_refunded_centavos > 0),
  replacement_sale_id            uuid UNIQUE REFERENCES pos_sales (id),
  replacement_sale_reference     text UNIQUE,
  created_by_user_id             uuid NOT NULL REFERENCES app_users (id),
  created_at                     timestamptz NOT NULL,
  completed_by_user_id           uuid REFERENCES app_users (id),
  completed_at                   timestamptz,
  cancelled_by_user_id           uuid REFERENCES app_users (id),
  cancelled_at                   timestamptz,
  cancel_reason                  text,
  updated_at                     timestamptz NOT NULL,
  CHECK (
    (action_type = 'VOID' AND corrected_total_centavos = 0 AND corrected_items_snapshot IS NULL AND replacement_sale_id IS NULL AND replacement_sale_reference IS NULL)
    OR (action_type = 'CORRECT' AND corrected_total_centavos > 0 AND corrected_items_snapshot IS NOT NULL)
  ),
  CHECK (
    (
      status = 'PENDING'
      AND completed_by_user_id IS NULL
      AND completed_at IS NULL
      AND cancelled_by_user_id IS NULL
      AND cancelled_at IS NULL
      AND cash_tendered_centavos IS NULL
      AND cash_change_centavos IS NULL
      AND cash_refunded_centavos IS NULL
      AND replacement_sale_id IS NULL
      AND replacement_sale_reference IS NULL
    )
    OR (
      status = 'COMPLETED'
      AND completed_by_user_id IS NOT NULL
      AND completed_at IS NOT NULL
      AND cancelled_by_user_id IS NULL
      AND cancelled_at IS NULL
      AND (
        action_type = 'VOID'
        OR (replacement_sale_id IS NOT NULL AND replacement_sale_reference IS NOT NULL)
      )
      AND (
        (cash_difference_centavos < 0 AND cash_refunded_centavos = -cash_difference_centavos AND cash_tendered_centavos IS NULL AND cash_change_centavos IS NULL)
        OR (cash_difference_centavos > 0 AND cash_refunded_centavos IS NULL AND cash_tendered_centavos IS NOT NULL AND cash_tendered_centavos >= cash_difference_centavos AND cash_change_centavos = cash_tendered_centavos - cash_difference_centavos)
        OR (cash_difference_centavos = 0 AND cash_refunded_centavos IS NULL AND cash_tendered_centavos IS NULL AND cash_change_centavos IS NULL)
      )
    )
    OR (
      status = 'CANCELLED_NO_CASH'
      AND completed_by_user_id IS NULL
      AND completed_at IS NULL
      AND cancelled_by_user_id IS NOT NULL
      AND cancelled_at IS NOT NULL
      AND cash_tendered_centavos IS NULL
      AND cash_change_centavos IS NULL
      AND cash_refunded_centavos IS NULL
      AND replacement_sale_id IS NULL
      AND replacement_sale_reference IS NULL
    )
  )
);

CREATE UNIQUE INDEX pos_sale_action_requests_one_pending_per_sale_idx
  ON pos_sale_action_requests (original_sale_id)
  WHERE status = 'PENDING';

CREATE INDEX pos_sale_action_requests_day_status_idx
  ON pos_sale_action_requests (original_business_day_id, status, created_at);

CREATE INDEX pos_sale_action_requests_sale_created_idx
  ON pos_sale_action_requests (original_sale_id, created_at DESC);

ALTER TABLE pos_sale_action_requests ENABLE ROW LEVEL SECURITY;
