-- Allow already-started pre-0010 PAYMENT_PENDING container package checkouts
-- (whose quote_snapshot omitted includedGripo) to finish confirmation after 0010
-- without guessing a faucet type. Express still requires includedGripo on all
-- new POST /api/pos/checkouts requests.
ALTER TABLE pos_sale_items
  DROP CONSTRAINT IF EXISTS pos_sale_items_container_gripo_required_check;
