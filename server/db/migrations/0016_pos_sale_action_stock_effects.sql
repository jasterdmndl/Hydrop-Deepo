-- DEC-100..DEC-105 / INV-012..INV-015: Final POS Task 3 linked stock effects,
-- pending sale-action stock reservations, and post-sale damaged/held exclusions.

ALTER TABLE inventory_stock_movements
  DROP CONSTRAINT IF EXISTS inventory_stock_movements_movement_type_check;

ALTER TABLE inventory_stock_movements
  ADD CONSTRAINT inventory_stock_movements_movement_type_check
  CHECK (
    movement_type IN (
      'POS_SALE',
      'PRIOR_DAY_SETTLEMENT',
      'PHYSICAL_COUNT_RECONCILIATION',
      'SALE_ACTION_DEDUCTION',
      'SALE_ACTION_RESTORATION'
    )
  );

ALTER TABLE inventory_stock_movements
  ADD COLUMN IF NOT EXISTS sale_action_id uuid REFERENCES pos_sale_action_requests (id);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_stock_movements_sale_action_item_type_uidx
  ON inventory_stock_movements (sale_action_id, item_id, movement_type)
  WHERE sale_action_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pos_sale_action_stock_commitments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_action_id  uuid NOT NULL REFERENCES pos_sale_action_requests (id) ON DELETE CASCADE,
  item_id         uuid NOT NULL REFERENCES inventory_items (id),
  quantity        integer NOT NULL CHECK (quantity > 0),
  status          text NOT NULL CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED')),
  created_at      timestamptz NOT NULL,
  resolved_at     timestamptz,
  UNIQUE (sale_action_id, item_id)
);

CREATE INDEX IF NOT EXISTS pos_sale_action_stock_commitments_active_item_idx
  ON pos_sale_action_stock_commitments (item_id)
  WHERE status = 'ACTIVE';

ALTER TABLE pos_sale_action_stock_commitments ENABLE ROW LEVEL SECURITY;

ALTER TABLE inventory_stock_holds
  ADD COLUMN IF NOT EXISTS sale_action_id uuid REFERENCES pos_sale_action_requests (id);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_stock_holds_sale_action_item_uidx
  ON inventory_stock_holds (sale_action_id, item_id)
  WHERE sale_action_id IS NOT NULL;
