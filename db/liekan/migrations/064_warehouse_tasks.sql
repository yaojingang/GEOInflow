-- Durable references for internal analytical work. Payloads and per-visit facts
-- remain in the warehouse/queue; this table contains authority and progress only.
CREATE TABLE liekan_warehouse_task (
  task_id uuid PRIMARY KEY,
  website_id uuid NOT NULL REFERENCES website(website_id) ON DELETE CASCADE,
  epoch bigint NOT NULL,
  deletion_revision bigint NOT NULL,
  policy_revision bigint NOT NULL,
  kind text NOT NULL CHECK(kind IN ('browser-risk')),
  scope_key text NOT NULL,
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','published','cancelled')),
  attempt_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_enqueue_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX liekan_warehouse_task_active_scope ON liekan_warehouse_task(website_id,kind)
  WHERE status IN ('pending','confirmed');
CREATE INDEX liekan_warehouse_task_delivery ON liekan_warehouse_task(next_enqueue_at) WHERE status='pending';
