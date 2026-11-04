-- Constant-time resume per family; the immutable page chain remains the audit trail.
CREATE TABLE liekan_warehouse_migration_family (
  migration_id uuid NOT NULL REFERENCES liekan_warehouse_migration(migration_id),
  family text NOT NULL,
  cursor_value jsonb NOT NULL DEFAULT 'null'::jsonb,
  pages bigint NOT NULL DEFAULT 0 CHECK (pages >= 0),
  rows bigint NOT NULL DEFAULT 0 CHECK (rows >= 0),
  status text NOT NULL DEFAULT 'copying' CHECK (status IN ('copying', 'copied', 'verified')),
  digest character(64),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (migration_id, family)
);
