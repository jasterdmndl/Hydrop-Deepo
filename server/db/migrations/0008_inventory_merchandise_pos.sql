-- Inventory products shown in POS and standalone merchandise sales
-- (DEC-068 through DEC-070, DEC-067 RLS).

ALTER TABLE inventory_items
  DROP CONSTRAINT IF EXISTS inventory_items_category_check;

ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_category_check
  CHECK (category IN ('CONTAINER', 'MERCHANDISE'));

ALTER TABLE inventory_items
  ADD COLUMN description text,
  ADD COLUMN unit_price_centavos integer CHECK (unit_price_centavos IS NULL OR unit_price_centavos > 0),
  ADD COLUMN show_in_pos boolean NOT NULL DEFAULT false,
  ADD COLUMN pos_section text CHECK (pos_section IS NULL OR pos_section IN ('CONTAINERS', 'TAKIP_ACCESSORIES', 'CHANGE_OF_GRIPO')),
  ADD COLUMN created_by_user_id uuid REFERENCES app_users (id);

ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_merchandise_fields_check
  CHECK (
    category <> 'MERCHANDISE'
    OR (container_shape IS NULL AND unit_price_centavos IS NOT NULL AND unit_price_centavos > 0)
  );

ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_pos_visibility_check
  CHECK (
    NOT show_in_pos
    OR (unit_price_centavos IS NOT NULL AND unit_price_centavos > 0 AND pos_section IS NOT NULL)
  );

CREATE UNIQUE INDEX inventory_items_name_lower_uidx
  ON inventory_items (LOWER(BTRIM(name)));

CREATE TABLE inventory_stock_movements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES inventory_items (id),
  movement_type   text NOT NULL CHECK (movement_type IN ('POS_SALE')),
  quantity_delta  integer NOT NULL CHECK (quantity_delta <> 0),
  balance_before  integer NOT NULL CHECK (balance_before >= 0),
  balance_after   integer NOT NULL CHECK (balance_after >= 0),
  unit            text NOT NULL,
  pos_sale_id     uuid REFERENCES pos_sales (id),
  pos_reference   text,
  actor_user_id   uuid NOT NULL REFERENCES app_users (id),
  recorded_at     timestamptz NOT NULL,
  UNIQUE (pos_sale_id, item_id)
);

CREATE INDEX inventory_stock_movements_item_recorded_idx
  ON inventory_stock_movements (item_id, recorded_at DESC);

ALTER TABLE inventory_stock_movements ENABLE ROW LEVEL SECURITY;

CREATE TABLE pos_checkout_stock_commitments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id  uuid NOT NULL REFERENCES pos_checkouts (id),
  item_id      uuid NOT NULL REFERENCES inventory_items (id),
  quantity     integer NOT NULL CHECK (quantity > 0),
  status       text NOT NULL CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED')),
  created_at   timestamptz NOT NULL,
  resolved_at  timestamptz,
  UNIQUE (checkout_id, item_id)
);

CREATE INDEX pos_checkout_stock_commitments_active_item_idx
  ON pos_checkout_stock_commitments (item_id)
  WHERE status = 'ACTIVE';

ALTER TABLE pos_checkout_stock_commitments ENABLE ROW LEVEL SECURITY;

-- Standalone merchandise sales contribute 0 refill containers and 0 L water volume.
ALTER TABLE pos_checkouts
  DROP CONSTRAINT IF EXISTS pos_checkouts_total_containers_check,
  DROP CONSTRAINT IF EXISTS pos_checkouts_total_volume_ml_check;

ALTER TABLE pos_checkouts
  ADD CONSTRAINT pos_checkouts_total_containers_check CHECK (total_containers >= 0),
  ADD CONSTRAINT pos_checkouts_total_volume_ml_check CHECK (total_volume_ml >= 0);

ALTER TABLE pos_sales
  DROP CONSTRAINT IF EXISTS pos_sales_total_containers_check,
  DROP CONSTRAINT IF EXISTS pos_sales_total_volume_ml_check;

ALTER TABLE pos_sales
  ADD CONSTRAINT pos_sales_total_containers_check CHECK (total_containers >= 0),
  ADD CONSTRAINT pos_sales_total_volume_ml_check CHECK (total_volume_ml >= 0);

ALTER TABLE pos_sale_items
  DROP CONSTRAINT IF EXISTS pos_sale_items_item_kind_check,
  DROP CONSTRAINT IF EXISTS pos_sale_items_water_type_check,
  DROP CONSTRAINT IF EXISTS pos_sale_items_unit_volume_ml_check;

ALTER TABLE pos_sale_items
  ALTER COLUMN water_type DROP NOT NULL;

ALTER TABLE pos_sale_items
  ADD COLUMN inventory_item_id uuid REFERENCES inventory_items (id),
  ADD COLUMN stock_unit text,
  ADD COLUMN pos_section text CHECK (pos_section IS NULL OR pos_section IN ('CONTAINERS', 'TAKIP_ACCESSORIES', 'CHANGE_OF_GRIPO'));

ALTER TABLE pos_sale_items
  ADD CONSTRAINT pos_sale_items_item_kind_check
  CHECK (item_kind IN ('STANDARD', 'CUSTOM', 'MERCHANDISE'));

ALTER TABLE pos_sale_items
  ADD CONSTRAINT pos_sale_items_kind_fields_check
  CHECK (
    (
      item_kind IN ('STANDARD', 'CUSTOM')
      AND water_type IN ('PURIFIED', 'ALKALINE')
      AND unit_volume_ml > 0
      AND inventory_item_id IS NULL
    )
    OR (
      item_kind = 'MERCHANDISE'
      AND water_type IS NULL
      AND unit_volume_ml = 0
      AND inventory_item_id IS NOT NULL
      AND stock_unit IS NOT NULL
    )
  );
