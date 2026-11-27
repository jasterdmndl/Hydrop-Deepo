-- Final Inventory Task 2 (INV-023..030, INV-040, INV-041):
-- Support late-entry dates, physical-count coverage confirmation, pending Owner review,
-- and zero-effect / supporting-reconciliation history without distorting balances or Stock Trend.

ALTER TABLE inventory_stock_movements
  DROP CONSTRAINT IF EXISTS inventory_stock_movements_quantity_delta_check;

ALTER TABLE inventory_stock_movements
  ADD COLUMN entry_status text NOT NULL DEFAULT 'APPLIED',
  ADD COLUMN entered_quantity numeric(12, 4),
  ADD COLUMN coverage_mode text,
  ADD COLUMN covered_quantity numeric(12, 4) NOT NULL DEFAULT 0,
  ADD COLUMN supporting_reconciliation_id uuid REFERENCES inventory_reconciliations(id),
  ADD COLUMN covered_by_opening_count boolean NOT NULL DEFAULT false,
  ADD COLUMN reviewed_by_user_id uuid REFERENCES app_users(id),
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN review_note text,
  ADD COLUMN review_request_key text,
  ADD COLUMN balance_applied_at timestamptz;

UPDATE inventory_stock_movements
   SET entered_quantity = CASE
         WHEN movement_type IN ('STOCK_RECEIVED', 'STOCK_USED') THEN ABS(quantity_delta)
         ELSE NULL
       END,
       coverage_mode = CASE
         WHEN movement_type IN ('STOCK_RECEIVED', 'STOCK_USED') THEN 'NONE'
         ELSE NULL
       END;

ALTER TABLE inventory_stock_movements
  ADD CONSTRAINT inventory_stock_movements_entry_status_check
  CHECK (entry_status IN ('APPLIED', 'PENDING_REVIEW'));

ALTER TABLE inventory_stock_movements
  ADD CONSTRAINT inventory_stock_movements_entered_quantity_check
  CHECK (entered_quantity IS NULL OR entered_quantity > 0);

ALTER TABLE inventory_stock_movements
  ADD CONSTRAINT inventory_stock_movements_coverage_mode_check
  CHECK (coverage_mode IS NULL OR coverage_mode IN ('NONE', 'FULL', 'PARTIAL', 'UNCLEAR'));

ALTER TABLE inventory_stock_movements
  ADD CONSTRAINT inventory_stock_movements_covered_quantity_check
  CHECK (covered_quantity >= 0);

ALTER TABLE inventory_stock_movements
  ADD CONSTRAINT inventory_stock_movements_quantity_delta_check
  CHECK (
    quantity_delta <> 0
    OR (
      movement_type IN ('STOCK_RECEIVED', 'STOCK_USED')
      AND (entry_status = 'PENDING_REVIEW' OR coverage_mode = 'FULL')
    )
  );

ALTER TABLE inventory_stock_movements
  ADD CONSTRAINT inventory_stock_movements_pending_review_check
  CHECK (
    entry_status <> 'PENDING_REVIEW'
    OR (
      movement_type IN ('STOCK_RECEIVED', 'STOCK_USED')
      AND quantity_delta = 0
      AND coverage_mode = 'UNCLEAR'
      AND balance_applied_at IS NULL
    )
  );

ALTER TABLE inventory_stock_movements
  ADD CONSTRAINT inventory_stock_movements_supporting_source_check
  CHECK (NOT (supporting_reconciliation_id IS NOT NULL AND covered_by_opening_count = true));

CREATE UNIQUE INDEX idx_inventory_stock_movements_review_request_key
  ON inventory_stock_movements (review_request_key)
  WHERE review_request_key IS NOT NULL;

CREATE INDEX idx_inventory_stock_movements_pending_review
  ON inventory_stock_movements (item_id, recorded_at DESC)
  WHERE entry_status = 'PENDING_REVIEW';
