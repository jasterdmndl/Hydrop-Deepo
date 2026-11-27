-- Final Inventory Task 1 (INV-003..009, INV-038, INV-039, INV-044):
-- Operating supplies, exact decimal quantities (numeric(12, 4)), supply-only
-- negative balances with discrepancy flag, and Stock Received / Stock Used movements.

-- 1. inventory_items: add OPERATING_SUPPLY category, decimal/discrepancy flags, and numeric(12, 4) balances.
ALTER TABLE inventory_items
  DROP CONSTRAINT IF EXISTS inventory_items_category_check,
  DROP CONSTRAINT IF EXISTS inventory_items_current_quantity_check,
  DROP CONSTRAINT IF EXISTS inventory_items_low_stock_level_check;

ALTER TABLE inventory_items
  ALTER COLUMN current_quantity TYPE numeric(12, 4) USING current_quantity::numeric(12, 4),
  ALTER COLUMN low_stock_level TYPE numeric(12, 4) USING low_stock_level::numeric(12, 4),
  ADD COLUMN allow_decimal_quantity boolean NOT NULL DEFAULT false,
  ADD COLUMN needs_reconciliation boolean NOT NULL DEFAULT false;

ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_category_check
  CHECK (category IN ('CONTAINER', 'MERCHANDISE', 'OPERATING_SUPPLY'));

ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_current_quantity_check
  CHECK (current_quantity IS NULL OR category = 'OPERATING_SUPPLY' OR current_quantity >= 0);

ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_low_stock_level_check
  CHECK (low_stock_level IS NULL OR (low_stock_level > 0 AND low_stock_level <= 1000000));

ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_decimal_category_check
  CHECK (NOT allow_decimal_quantity OR category = 'OPERATING_SUPPLY');

ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_supply_fields_check
  CHECK (
    category <> 'OPERATING_SUPPLY'
    OR (
      container_shape IS NULL
      AND unit_price_centavos IS NULL
      AND show_in_pos = false
      AND pos_section IS NULL
      AND faucet_reporting_type IS NULL
    )
  );

-- 2. inventory_opening_counts: exact numeric(12, 4) quantities.
ALTER TABLE inventory_opening_counts
  DROP CONSTRAINT IF EXISTS inventory_opening_counts_quantity_check;

ALTER TABLE inventory_opening_counts
  ALTER COLUMN quantity TYPE numeric(12, 4) USING quantity::numeric(12, 4);

ALTER TABLE inventory_opening_counts
  ADD CONSTRAINT inventory_opening_counts_quantity_check
  CHECK (quantity >= 0);

-- 3. inventory_reconciliations: exact numeric(12, 4) quantities (allow negative balance_before for supplies).
ALTER TABLE inventory_reconciliations
  DROP CONSTRAINT IF EXISTS inventory_reconciliations_physical_count_check,
  DROP CONSTRAINT IF EXISTS inventory_reconciliations_balance_after_check;

ALTER TABLE inventory_reconciliations
  ALTER COLUMN balance_before TYPE numeric(12, 4) USING balance_before::numeric(12, 4),
  ALTER COLUMN physical_count TYPE numeric(12, 4) USING physical_count::numeric(12, 4),
  ALTER COLUMN quantity_delta TYPE numeric(12, 4) USING quantity_delta::numeric(12, 4),
  ALTER COLUMN balance_after TYPE numeric(12, 4) USING balance_after::numeric(12, 4);

ALTER TABLE inventory_reconciliations
  ADD CONSTRAINT inventory_reconciliations_physical_count_check
  CHECK (physical_count >= 0);

ALTER TABLE inventory_reconciliations
  ADD CONSTRAINT inventory_reconciliations_balance_after_check
  CHECK (balance_after >= 0);

-- 4. inventory_stock_movements: exact numeric(12, 4) deltas/balances, negative supply balances,
-- STOCK_RECEIVED / STOCK_USED movement types, effective_date, and idempotent request_key.
ALTER TABLE inventory_stock_movements
  DROP CONSTRAINT IF EXISTS inventory_stock_movements_quantity_delta_check,
  DROP CONSTRAINT IF EXISTS inventory_stock_movements_balance_before_check,
  DROP CONSTRAINT IF EXISTS inventory_stock_movements_balance_after_check,
  DROP CONSTRAINT IF EXISTS inventory_stock_movements_movement_type_check;

ALTER TABLE inventory_stock_movements
  ALTER COLUMN quantity_delta TYPE numeric(12, 4) USING quantity_delta::numeric(12, 4),
  ALTER COLUMN balance_before TYPE numeric(12, 4) USING balance_before::numeric(12, 4),
  ALTER COLUMN balance_after TYPE numeric(12, 4) USING balance_after::numeric(12, 4),
  ADD COLUMN effective_date date,
  ADD COLUMN request_key text;

ALTER TABLE inventory_stock_movements
  ADD CONSTRAINT inventory_stock_movements_quantity_delta_check
  CHECK (quantity_delta <> 0);

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
      'STOCK_USED'
    )
  );

CREATE UNIQUE INDEX inventory_stock_movements_request_key_uidx
  ON inventory_stock_movements (request_key)
  WHERE request_key IS NOT NULL;
