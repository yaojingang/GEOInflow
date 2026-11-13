-- Analytics facts belong to ClickHouse. These tables contain authority, durable
-- references and bounded recovery work; no visitor payload or raw IP is stored here.
CREATE TABLE liekan_warehouse_installation (
  id integer PRIMARY KEY CHECK (id = 1),
  installation_id uuid NOT NULL UNIQUE,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  routing_version integer NOT NULL CHECK (routing_version > 0),
  topic_name text NOT NULL,
  topic_id text NOT NULL,
  partition_count integer NOT NULL CHECK (partition_count BETWEEN 1 AND 4096),
  authority text NOT NULL CHECK (authority IN ('postgres', 'clickhouse', 'frozen')),
  transition text NOT NULL CHECK (transition IN ('none', 'shadow', 'rollback', 'draining', 'exited')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE liekan_warehouse_site (
  website_id uuid PRIMARY KEY REFERENCES website(website_id) ON DELETE CASCADE,
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  publication bigint NOT NULL DEFAULT 0 CHECK (publication >= 0),
  deletion_revision bigint NOT NULL DEFAULT 0 CHECK (deletion_revision >= 0),
  policy_revision bigint NOT NULL DEFAULT 0 CHECK (policy_revision >= 0),
  governance_revision bigint NOT NULL DEFAULT 0 CHECK (governance_revision >= 0),
  repair_revision bigint NOT NULL DEFAULT 0 CHECK (repair_revision >= 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'frozen', 'deleting')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE liekan_warehouse_partition (
  topic_id text NOT NULL,
  partition integer NOT NULL CHECK (partition >= 0),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  owner_id uuid,
  lease_until timestamptz,
  discovered_offset bigint NOT NULL DEFAULT -1 CHECK (discovered_offset >= -1),
  safe_offset bigint NOT NULL DEFAULT -1 CHECK (safe_offset >= -1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_id, partition),
  CHECK (safe_offset <= discovered_offset)
);

CREATE TABLE liekan_warehouse_attempt (
  attempt_id uuid PRIMARY KEY,
  topic_id text NOT NULL,
  partition integer NOT NULL,
  generation bigint NOT NULL,
  owner_id uuid NOT NULL,
  website_id uuid NOT NULL REFERENCES website(website_id) ON DELETE CASCADE,
  epoch bigint NOT NULL,
  deletion_revision bigint NOT NULL,
  policy_revision bigint NOT NULL,
  first_offset bigint NOT NULL CHECK (first_offset >= 0),
  last_offset bigint NOT NULL CHECK (last_offset >= first_offset),
  input_count integer NOT NULL CHECK (input_count BETWEEN 1 AND 100000),
  input_digest character(64) NOT NULL,
  version bigint,
  status text NOT NULL CHECK (status IN ('intent', 'confirmed', 'projected', 'aborted')),
  decision_projected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (topic_id, partition) REFERENCES liekan_warehouse_partition(topic_id, partition),
  CHECK ((status IN ('confirmed', 'projected')) = (version IS NOT NULL))
);
CREATE INDEX liekan_warehouse_attempt_recovery ON liekan_warehouse_attempt(status, updated_at);

CREATE TABLE liekan_warehouse_work (
  topic_id text NOT NULL,
  partition integer NOT NULL,
  offset_id bigint NOT NULL CHECK (offset_id >= 0),
  input_id uuid NOT NULL,
  website_id uuid NOT NULL REFERENCES website(website_id) ON DELETE CASCADE,
  session_id uuid,
  identity_key text NOT NULL,
  attempt_id uuid REFERENCES liekan_warehouse_attempt(attempt_id),
  status text NOT NULL CHECK (status IN ('pending', 'working', 'confirmed', 'quarantined', 'cancelled')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_id, partition, offset_id),
  FOREIGN KEY (topic_id, partition) REFERENCES liekan_warehouse_partition(topic_id, partition)
);
-- A business key has one decision in flight even within the same owner process.
CREATE UNIQUE INDEX liekan_warehouse_work_single_flight
  ON liekan_warehouse_work(topic_id, identity_key) WHERE status = 'working';
CREATE INDEX liekan_warehouse_work_pending ON liekan_warehouse_work(topic_id, partition, offset_id)
  WHERE status IN ('pending', 'working', 'quarantined');

CREATE TABLE liekan_warehouse_candidate (
  candidate_id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES liekan_warehouse_attempt(attempt_id),
  website_id uuid NOT NULL REFERENCES website(website_id) ON DELETE CASCADE,
  epoch bigint NOT NULL,
  family text NOT NULL,
  row_count bigint NOT NULL CHECK (row_count >= 0),
  digest character(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('building', 'verified', 'published', 'aborted')),
  publication bigint,
  owner_id uuid NOT NULL,
  generation bigint NOT NULL,
  lease_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'published') = (publication IS NOT NULL))
);
CREATE UNIQUE INDEX liekan_warehouse_candidate_selected
  ON liekan_warehouse_candidate(attempt_id, family) WHERE status = 'published';

CREATE TABLE liekan_warehouse_deletion (
  operation_id uuid PRIMARY KEY,
  website_id uuid NOT NULL REFERENCES website(website_id) ON DELETE CASCADE,
  session_id uuid,
  kind text NOT NULL CHECK (kind IN ('session', 'reset', 'website')),
  epoch bigint NOT NULL,
  revision bigint NOT NULL,
  version bigint NOT NULL,
  topic_id text NOT NULL,
  boundary jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'boundary', 'projected', 'active', 'reclaimed')),
  owner_id uuid,
  generation bigint NOT NULL DEFAULT 0,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (website_id, revision),
  CHECK (status = 'pending' OR boundary IS NOT NULL),
  CHECK (kind <> 'session' OR session_id IS NOT NULL)
);
CREATE INDEX liekan_warehouse_deletion_pending ON liekan_warehouse_deletion(website_id, session_id)
  WHERE status NOT IN ('active', 'reclaimed');

CREATE TABLE liekan_warehouse_reference (
  reference_id uuid PRIMARY KEY,
  website_id uuid NOT NULL REFERENCES website(website_id) ON DELETE CASCADE,
  epoch bigint NOT NULL,
  publication bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('query', 'export', 'geo', 'repair', 'migration')),
  owner_id uuid NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX liekan_warehouse_reference_site ON liekan_warehouse_reference(website_id, epoch, publication);

CREATE TABLE liekan_warehouse_migration (
  migration_id uuid PRIMARY KEY,
  source_identity text NOT NULL,
  source_fingerprint character(64) NOT NULL,
  source_snapshot text NOT NULL,
  transform_version integer NOT NULL,
  phase text NOT NULL CHECK (phase IN ('prepared', 'capturing', 'backfill', 'verify', 'shadow', 'frozen', 'cutover', 'rollback', 'draining', 'exited', 'failed')),
  boundary jsonb,
  verified_digest character(64),
  owner_id uuid,
  generation bigint NOT NULL DEFAULT 0,
  lease_until timestamptz,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX liekan_warehouse_migration_active ON liekan_warehouse_migration((true))
  WHERE phase NOT IN ('exited', 'failed');

CREATE TABLE liekan_warehouse_checkpoint (
  migration_id uuid NOT NULL REFERENCES liekan_warehouse_migration(migration_id),
  family text NOT NULL,
  page_key text NOT NULL,
  cursor_before jsonb,
  cursor_after jsonb NOT NULL,
  candidate_id uuid NOT NULL,
  row_count bigint NOT NULL CHECK (row_count > 0),
  digest character(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('intent', 'verified', 'published')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (migration_id, family, page_key)
);
