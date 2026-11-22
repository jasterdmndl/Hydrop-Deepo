-- Inventory Round and Slim container opening stock (DEC-065, INV-005, DEC-067).

CREATE TABLE inventory_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE,
  name              text NOT NULL,
  category          text NOT NULL CHECK (category IN ('CONTAINER')),
  container_shape   text UNIQUE CHECK (container_shape IN ('ROUND', 'SLIM')),
  unit              text NOT NULL,
  current_quantity  integer CHECK (current_quantity IS NULL OR current_quantity >= 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_opening_counts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id              uuid NOT NULL UNIQUE REFERENCES inventory_items (id),
  quantity             integer NOT NULL CHECK (quantity >= 0),
  unit                 text NOT NULL,
  recorded_by_user_id  uuid NOT NULL REFERENCES app_users (id),
  recorded_at          timestamptz NOT NULL
);

INSERT INTO inventory_items (code, name, category, container_shape, unit, current_quantity)
VALUES
  ('ROUND', 'Round Container', 'CONTAINER', 'ROUND', 'containers', NULL),
  ('SLIM', 'Slim Container', 'CONTAINER', 'SLIM', 'containers', NULL)
ON CONFLICT (code) DO NOTHING;

-- Enable PostgreSQL row-level security (DEC-067). Express retains Owner/Cashier enforcement.
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_opening_counts ENABLE ROW LEVEL SECURITY;
