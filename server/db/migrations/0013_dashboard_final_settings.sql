-- DEC-087, DEC-090, DEC-093: Optional Low Stock alert levels on Inventory items
-- and standalone faucet reporting types on Inventory items and POS sale lines.

ALTER TABLE inventory_items
  ADD COLUMN low_stock_level integer CHECK (
    low_stock_level IS NULL OR (low_stock_level >= 1 AND low_stock_level <= 1000000)
  ),
  ADD COLUMN faucet_reporting_type text CHECK (
    faucet_reporting_type IS NULL OR faucet_reporting_type IN ('PUSH_TYPE', 'TWIST_TYPE')
  );

ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_faucet_reporting_type_category_check
  CHECK (category = 'MERCHANDISE' OR faucet_reporting_type IS NULL);

ALTER TABLE pos_sale_items
  ADD COLUMN faucet_reporting_type text CHECK (
    faucet_reporting_type IS NULL OR faucet_reporting_type IN ('PUSH_TYPE', 'TWIST_TYPE', 'NONE')
  );

ALTER TABLE pos_sale_items
  ADD CONSTRAINT pos_sale_items_faucet_reporting_type_kind_check
  CHECK (item_kind = 'MERCHANDISE' OR faucet_reporting_type IS NULL);
