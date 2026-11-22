-- DEC-075: Allow Owner prior-day settlement for merchandise-only checkouts
-- (including 0-container / 0-mL merchandise or empty container packages) and
-- link the one-time stock deduction to inventory_stock_movements.

ALTER TABLE pos_prior_day_settlements
  DROP CONSTRAINT IF EXISTS pos_prior_day_settlements_total_containers_check,
  DROP CONSTRAINT IF EXISTS pos_prior_day_settlements_total_volume_ml_check;

ALTER TABLE pos_prior_day_settlements
  ADD CONSTRAINT pos_prior_day_settlements_total_containers_check CHECK (total_containers >= 0),
  ADD CONSTRAINT pos_prior_day_settlements_total_volume_ml_check CHECK (total_volume_ml >= 0);

ALTER TABLE inventory_stock_movements
  DROP CONSTRAINT IF EXISTS inventory_stock_movements_movement_type_check;

ALTER TABLE inventory_stock_movements
  ADD CONSTRAINT inventory_stock_movements_movement_type_check
  CHECK (movement_type IN ('POS_SALE', 'PRIOR_DAY_SETTLEMENT', 'PHYSICAL_COUNT_RECONCILIATION'));

ALTER TABLE inventory_stock_movements
  ADD COLUMN IF NOT EXISTS prior_day_settlement_id uuid REFERENCES pos_prior_day_settlements (id);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_stock_movements_settlement_item_uidx
  ON inventory_stock_movements (prior_day_settlement_id, item_id)
  WHERE prior_day_settlement_id IS NOT NULL;
