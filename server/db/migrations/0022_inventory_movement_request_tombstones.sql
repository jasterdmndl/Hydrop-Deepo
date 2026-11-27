-- Final Inventory Task 1 (Finding 1):
-- Server-side cancellation tombstones for unresolved Stock Received / Stock Used request keys
-- so cancelling an in-flight attempt blocks any delayed original POST from committing.

CREATE TABLE inventory_cancelled_movement_requests (
  request_key text PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  movement_type text NOT NULL CHECK (movement_type IN ('STOCK_RECEIVED', 'STOCK_USED')),
  actor_user_id uuid NOT NULL REFERENCES app_users(id),
  cancelled_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventory_cancelled_movement_requests_actor
  ON inventory_cancelled_movement_requests (actor_user_id, cancelled_at DESC);

ALTER TABLE inventory_cancelled_movement_requests ENABLE ROW LEVEL SECURITY;
