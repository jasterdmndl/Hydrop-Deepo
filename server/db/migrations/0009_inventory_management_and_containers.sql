-- DEC-073 & DEC-074: Reusable custom POS sections, container package snapshots,
-- product archiving, and INV-009 physical-count reconciliations (with DEC-067 RLS).

CREATE TABLE inventory_pos_sections (
  code                text PRIMARY KEY,
  name                text NOT NULL,
  is_built_in         boolean NOT NULL DEFAULT false,
  sort_order          integer NOT NULL DEFAULT 100,
  created_by_user_id  uuid REFERENCES app_users (id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX inventory_pos_sections_name_lower_uidx
  ON inventory_pos_sections (LOWER(BTRIM(name)));

INSERT INTO inventory_pos_sections (code, name, is_built_in, sort_order)
VALUES
  ('CONTAINERS', 'Containers', true, 10),
  ('TAKIP_ACCESSORIES', 'Takip Types / Accessories', true, 20),
  ('CHANGE_OF_GRIPO', 'Change of Gripo', true, 30)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE inventory_pos_sections ENABLE ROW LEVEL SECURITY;

ALTER TABLE inventory_items
  DROP CONSTRAINT IF EXISTS inventory_items_pos_section_check;

ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_pos_section_fkey
  FOREIGN KEY (pos_section) REFERENCES inventory_pos_sections (code);

ALTER TABLE inventory_items
  DROP CONSTRAINT IF EXISTS inventory_items_pos_visibility_check;

ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_pos_visibility_check
  CHECK (
    NOT show_in_pos
    OR (
      category = 'CONTAINER'
      AND container_shape IN ('ROUND', 'SLIM')
      AND pos_section = 'CONTAINERS'
    )
    OR (
      category = 'MERCHANDISE'
      AND unit_price_centavos IS NOT NULL
      AND unit_price_centavos > 0
      AND pos_section IS NOT NULL
    )
  );

ALTER TABLE inventory_items
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by_user_id uuid REFERENCES app_users (id),
  ADD COLUMN stock_revision integer NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS inventory_items_name_lower_uidx;

CREATE UNIQUE INDEX inventory_items_active_name_lower_uidx
  ON inventory_items (LOWER(BTRIM(name)))
  WHERE archived_at IS NULL;

CREATE TABLE inventory_reconciliations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES inventory_items (id),
  request_key     text UNIQUE,
  balance_before  integer NOT NULL,
  physical_count  integer NOT NULL CHECK (physical_count >= 0),
  quantity_delta  integer NOT NULL,
  balance_after   integer NOT NULL CHECK (balance_after >= 0),
  unit            text NOT NULL,
  reason          text NOT NULL,
  actor_user_id   uuid NOT NULL REFERENCES app_users (id),
  recorded_at     timestamptz NOT NULL
);

CREATE INDEX inventory_reconciliations_item_recorded_idx
  ON inventory_reconciliations (item_id, recorded_at DESC);

ALTER TABLE inventory_reconciliations ENABLE ROW LEVEL SECURITY;

ALTER TABLE inventory_stock_movements
  DROP CONSTRAINT IF EXISTS inventory_stock_movements_movement_type_check;

ALTER TABLE inventory_stock_movements
  ADD CONSTRAINT inventory_stock_movements_movement_type_check
  CHECK (movement_type IN ('POS_SALE', 'PHYSICAL_COUNT_RECONCILIATION'));

ALTER TABLE inventory_stock_movements
  ADD COLUMN reconciliation_id uuid REFERENCES inventory_reconciliations (id),
  ADD COLUMN note text;

ALTER TABLE pos_sale_items
  ADD COLUMN included_gripo text
  CHECK (included_gripo IS NULL OR included_gripo IN ('PUSH_TYPE', 'TWIST_TYPE'));

ALTER TABLE pos_sale_items
  DROP CONSTRAINT IF EXISTS pos_sale_items_catalog_code_fkey,
  DROP CONSTRAINT IF EXISTS pos_sale_items_pos_section_check,
  DROP CONSTRAINT IF EXISTS pos_sale_items_item_kind_check,
  DROP CONSTRAINT IF EXISTS pos_sale_items_kind_fields_check;

ALTER TABLE pos_sale_items
  ADD CONSTRAINT pos_sale_items_item_kind_check
  CHECK (item_kind IN ('STANDARD', 'CUSTOM', 'MERCHANDISE', 'CONTAINER_PACKAGE'));

ALTER TABLE pos_sale_items
  ADD CONSTRAINT pos_sale_items_kind_fields_check
  CHECK (
    (
      item_kind IN ('STANDARD', 'CUSTOM')
      AND water_type IN ('PURIFIED', 'ALKALINE')
      AND unit_volume_ml > 0
      AND inventory_item_id IS NULL
      AND included_gripo IS NULL
    )
    OR (
      item_kind = 'MERCHANDISE'
      AND water_type IS NULL
      AND unit_volume_ml = 0
      AND inventory_item_id IS NOT NULL
      AND stock_unit IS NOT NULL
      AND included_gripo IS NULL
    )
    OR (
      item_kind = 'CONTAINER_PACKAGE'
      AND catalog_code IN (
        'ROUND_EMPTY',
        'ROUND_PURIFIED',
        'ROUND_ALKALINE',
        'SLIM_EMPTY',
        'SLIM_PURIFIED',
        'SLIM_ALKALINE'
      )
      AND inventory_item_id IS NOT NULL
      AND stock_unit IS NOT NULL
      AND included_gripo IN ('PUSH_TYPE', 'TWIST_TYPE')
      AND (
        (water_type IS NULL AND unit_volume_ml = 0)
        OR (water_type IN ('PURIFIED', 'ALKALINE') AND unit_volume_ml = 25000)
      )
    )
  );
