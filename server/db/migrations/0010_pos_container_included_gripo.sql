-- Finding 5: forward migration to record included_gripo on container package sale lines (POS-012).
-- Upgrades databases that applied either revision of 0009 without resetting data or guessing
-- historical container faucet choices.

ALTER TABLE pos_sale_items
  ADD COLUMN IF NOT EXISTS included_gripo text;

ALTER TABLE pos_sale_items
  DROP CONSTRAINT IF EXISTS pos_sale_items_included_gripo_check,
  DROP CONSTRAINT IF EXISTS pos_sale_items_kind_fields_check,
  DROP CONSTRAINT IF EXISTS pos_sale_items_container_gripo_required_check;

ALTER TABLE pos_sale_items
  ADD CONSTRAINT pos_sale_items_included_gripo_check
  CHECK (included_gripo IS NULL OR included_gripo IN ('PUSH_TYPE', 'TWIST_TYPE'));

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
      AND (included_gripo IS NULL OR included_gripo IN ('PUSH_TYPE', 'TWIST_TYPE'))
      AND (
        (water_type IS NULL AND unit_volume_ml = 0)
        OR (water_type IN ('PURIFIED', 'ALKALINE') AND unit_volume_ml = 25000)
      )
    )
  );

-- Historical pre-0010 container package rows keep included_gripo IS NULL;
-- new container package inserts must supply PUSH_TYPE or TWIST_TYPE.
ALTER TABLE pos_sale_items
  ADD CONSTRAINT pos_sale_items_container_gripo_required_check
  CHECK (
    item_kind <> 'CONTAINER_PACKAGE'
    OR (included_gripo IS NOT NULL AND included_gripo IN ('PUSH_TYPE', 'TWIST_TYPE'))
  )
  NOT VALID;
