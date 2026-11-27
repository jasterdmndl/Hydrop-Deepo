-- Final Inventory Task 3 (INV-010, INV-011, INV-016..022, INV-031..037, INV-043):
-- Owner-only corrections and cancellations of saved Stock Received / Stock Used entries,
-- including repeated corrections, negative-merchandise count-first blocks, two-item receipt
-- corrections, date/note/purpose fixes, pending count-review resolution, and full audit history.

CREATE TABLE inventory_movement_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_id uuid NOT NULL REFERENCES inventory_stock_movements(id),
  correction_kind text NOT NULL CHECK (
    correction_kind IN ('QUANTITY', 'CANCEL', 'RECEIPT_ITEM', 'METADATA')
  ),
  status text NOT NULL CHECK (status IN ('APPLIED', 'PENDING_REVIEW')),
  reason text NOT NULL,
  request_key text NOT NULL,
  review_request_key text,
  previous_quantity numeric(12, 4),
  new_quantity numeric(12, 4),
  previous_item_id uuid REFERENCES inventory_items(id),
  new_item_id uuid REFERENCES inventory_items(id),
  previous_unit text,
  new_unit text,
  previous_effective_date date,
  new_effective_date date,
  previous_note text,
  new_note text,
  primary_item_id uuid NOT NULL REFERENCES inventory_items(id),
  primary_raw_delta numeric(12, 4) NOT NULL DEFAULT 0,
  primary_coverage_mode text CHECK (
    primary_coverage_mode IS NULL
    OR primary_coverage_mode IN ('NONE', 'FULL', 'PARTIAL', 'UNCLEAR', 'DIFFERENT_UNIT_RECONCILED')
  ),
  primary_covered_quantity numeric(12, 4) NOT NULL DEFAULT 0 CHECK (primary_covered_quantity >= 0),
  primary_applied_delta numeric(12, 4) NOT NULL DEFAULT 0,
  primary_supporting_reconciliation_id uuid REFERENCES inventory_reconciliations(id),
  primary_covered_by_opening_count boolean NOT NULL DEFAULT false,
  secondary_item_id uuid REFERENCES inventory_items(id),
  secondary_raw_delta numeric(12, 4) NOT NULL DEFAULT 0,
  secondary_coverage_mode text CHECK (
    secondary_coverage_mode IS NULL
    OR secondary_coverage_mode IN ('NONE', 'FULL', 'PARTIAL', 'UNCLEAR', 'DIFFERENT_UNIT_RECONCILED')
  ),
  secondary_covered_quantity numeric(12, 4) NOT NULL DEFAULT 0 CHECK (secondary_covered_quantity >= 0),
  secondary_applied_delta numeric(12, 4) NOT NULL DEFAULT 0,
  secondary_supporting_reconciliation_id uuid REFERENCES inventory_reconciliations(id),
  secondary_covered_by_opening_count boolean NOT NULL DEFAULT false,
  created_by_user_id uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by_user_id uuid REFERENCES app_users(id),
  reviewed_at timestamptz,
  review_note text,
  CONSTRAINT inventory_movement_corrections_primary_source_check CHECK (
    NOT (primary_supporting_reconciliation_id IS NOT NULL AND primary_covered_by_opening_count = true)
  ),
  CONSTRAINT inventory_movement_corrections_secondary_source_check CHECK (
    NOT (secondary_supporting_reconciliation_id IS NOT NULL AND secondary_covered_by_opening_count = true)
  )
);

CREATE UNIQUE INDEX idx_inventory_movement_corrections_request_key
  ON inventory_movement_corrections (request_key);

CREATE UNIQUE INDEX idx_inventory_movement_corrections_review_request_key
  ON inventory_movement_corrections (review_request_key)
  WHERE review_request_key IS NOT NULL;

CREATE INDEX idx_inventory_movement_corrections_movement
  ON inventory_movement_corrections (movement_id, created_at ASC, id ASC);

CREATE INDEX idx_inventory_movement_corrections_pending
  ON inventory_movement_corrections (created_at DESC, id DESC)
  WHERE status = 'PENDING_REVIEW';

ALTER TABLE inventory_movement_corrections ENABLE ROW LEVEL SECURITY;

ALTER TABLE inventory_stock_movements
  DROP CONSTRAINT IF EXISTS inventory_stock_movements_movement_type_check,
  DROP CONSTRAINT IF EXISTS inventory_stock_movements_quantity_delta_check;

ALTER TABLE inventory_stock_movements
  ADD COLUMN is_cancelled boolean NOT NULL DEFAULT false,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by_user_id uuid REFERENCES app_users(id),
  ADD COLUMN current_quantity_value numeric(12, 4),
  ADD COLUMN current_item_id uuid REFERENCES inventory_items(id),
  ADD COLUMN current_effective_date date,
  ADD COLUMN current_note text,
  ADD COLUMN correction_version integer NOT NULL DEFAULT 0,
  ADD COLUMN source_correction_id uuid REFERENCES inventory_movement_corrections(id);

UPDATE inventory_stock_movements
   SET current_quantity_value = COALESCE(entered_quantity, ABS(quantity_delta)),
       current_item_id = item_id,
       current_effective_date = effective_date,
       current_note = note
 WHERE movement_type IN ('STOCK_RECEIVED', 'STOCK_USED');

ALTER TABLE inventory_stock_movements
  ADD CONSTRAINT inventory_stock_movements_movement_type_check
  CHECK (
    movement_type IN (
      'POS_SALE',
      'PRIOR_DAY_SETTLEMENT',
      'PHYSICAL_COUNT_RECONCILIATION',
      'SALE_ACTION_DEDUCTION',
      'SALE_ACTION_RESTORATION',
      'STOCK_RECEIVED',
      'STOCK_USED',
      'MOVEMENT_CORRECTION'
    )
  );

ALTER TABLE inventory_stock_movements
  ADD CONSTRAINT inventory_stock_movements_quantity_delta_check
  CHECK (
    quantity_delta <> 0
    OR is_cancelled = true
    OR (
      movement_type IN ('STOCK_RECEIVED', 'STOCK_USED')
      AND (entry_status = 'PENDING_REVIEW' OR coverage_mode = 'FULL')
    )
  );

CREATE INDEX idx_inventory_stock_movements_current_item
  ON inventory_stock_movements (current_item_id, recorded_at DESC, id DESC)
  WHERE current_item_id IS NOT NULL;
