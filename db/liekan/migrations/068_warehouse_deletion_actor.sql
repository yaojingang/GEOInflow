ALTER TABLE liekan_warehouse_deletion ADD COLUMN actor_id uuid;
-- Serializing lifecycle operations per resource makes the active deletion
-- revision an atomic visibility pointer even when a worker is replaced.
CREATE UNIQUE INDEX liekan_warehouse_deletion_single_flight
  ON liekan_warehouse_deletion(website_id) WHERE status NOT IN ('active','reclaimed');
