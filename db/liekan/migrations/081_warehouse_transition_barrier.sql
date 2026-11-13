CREATE TABLE liekan_warehouse_barrier (
  operation_id uuid PRIMARY KEY,
  kind text NOT NULL CHECK(kind IN('snapshot','cutover','rollback')),
  authority text NOT NULL CHECK(authority IN('postgres','clickhouse')),
  installation_revision bigint NOT NULL,
  topic_id text NOT NULL,
  boundary jsonb NOT NULL,
  status text NOT NULL CHECK(status IN('draining','frozen','completed','cancelled')),
  result_sequence bigint,
  frozen_revision bigint,
  completed_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX liekan_warehouse_barrier_active ON liekan_warehouse_barrier((true))
  WHERE status IN('draining','frozen');
