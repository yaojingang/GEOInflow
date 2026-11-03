-- Results at or before O are already represented by the verified PG snapshot.
-- Applying their additive counters again would count the same input twice.
CREATE TABLE liekan_warehouse_transition_baseline (
  id integer PRIMARY KEY CHECK(id=1),
  migration_id uuid NOT NULL REFERENCES liekan_warehouse_migration(migration_id),
  sequence bigint NOT NULL CHECK(sequence>=0),
  source_snapshot character(64) NOT NULL,
  verified_digest character(64) NOT NULL,
  status text NOT NULL CHECK(status IN('preparing','ready')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
