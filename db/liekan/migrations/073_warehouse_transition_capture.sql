-- Temporary migration/rollback authority journal. It is disabled in the final
-- CH installation and is drained explicitly before its payload is reclaimed.
CREATE TABLE liekan_warehouse_transition (
  id integer PRIMARY KEY CHECK(id=1),
  transition_id uuid NOT NULL UNIQUE,
  migration_id uuid REFERENCES liekan_warehouse_migration(migration_id),
  state text NOT NULL CHECK(state IN('capturing','frozen','draining','closed')),
  generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
  sequence bigint NOT NULL DEFAULT 0 CHECK(sequence>=0),
  sent_sequence bigint NOT NULL DEFAULT 0 CHECK(sent_sequence>=0),
  ch_sequence bigint NOT NULL DEFAULT 0 CHECK(ch_sequence>=0),
  pg_sequence bigint NOT NULL DEFAULT 0 CHECK(pg_sequence>=0),
  terminal_sequence bigint,
  topic_name text NOT NULL,
  topic_id text NOT NULL,
  owner_id uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(sent_sequence<=sequence AND ch_sequence<=sequence AND pg_sequence<=sequence),
  CHECK((state IN('draining','closed'))=(terminal_sequence IS NOT NULL))
);
CREATE TABLE liekan_warehouse_transition_result (
  sequence bigint PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE,
  authority text NOT NULL CHECK(authority IN('postgres','clickhouse')),
  website_id uuid NOT NULL,
  epoch bigint NOT NULL,
  site_version bigint NOT NULL,
  kind text NOT NULL CHECK(kind IN('decision','session','reset','website')),
  payload text NOT NULL,
  digest character(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE liekan_warehouse_transition_applied (
  target text NOT NULL CHECK(target IN('postgres','clickhouse')),
  sequence bigint NOT NULL,
  operation_id uuid NOT NULL,
  digest character(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(target,sequence),
  UNIQUE(target,operation_id)
);
CREATE FUNCTION liekan_warehouse_transition_result_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'warehouse-authoritative-result-is-immutable';
END $$;
CREATE TRIGGER liekan_warehouse_transition_result_immutable BEFORE UPDATE ON liekan_warehouse_transition_result
  FOR EACH ROW EXECUTE FUNCTION liekan_warehouse_transition_result_immutable();
