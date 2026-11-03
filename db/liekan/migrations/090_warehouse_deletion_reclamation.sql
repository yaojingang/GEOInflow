-- Durable progress for physically reclaiming already published deletions.
-- No wall-clock raw-data retention is enabled by this migration.
CREATE TABLE liekan_warehouse_deletion_gc (
  operation_id uuid PRIMARY KEY REFERENCES liekan_warehouse_deletion(operation_id),
  table_cursor integer NOT NULL DEFAULT 0 CHECK (table_cursor >= 0),
  pass bigint NOT NULL DEFAULT 0,
  owner_id uuid,
  lease_until timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX liekan_warehouse_deletion_gc_pending
  ON liekan_warehouse_deletion_gc(completed_at,updated_at);
