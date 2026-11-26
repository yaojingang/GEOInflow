ALTER TABLE liekan_warehouse_task DROP CONSTRAINT liekan_warehouse_task_kind_check;
ALTER TABLE liekan_warehouse_task ADD CONSTRAINT liekan_warehouse_task_kind_check
  CHECK(kind IN ('browser-risk','traffic-exclusion','history-repair-batch','history-repair-input'));

-- File control only. Per-event evidence, chunk bodies and complete error lists
-- are immutable ClickHouse facts. Bounded summaries support control transactions.
CREATE TABLE liekan_warehouse_repair_upload (
  run_id uuid NOT NULL REFERENCES liekan_history_repair_run(id) ON DELETE CASCADE,
  website_id uuid NOT NULL REFERENCES website(website_id) ON DELETE CASCADE,
  upload_id uuid NOT NULL,
  rulepack_hash varchar(64) NOT NULL,
  source text NOT NULL,
  state text NOT NULL CHECK(state IN ('open','finalized','discarded')),
  chunks integer NOT NULL CHECK(chunks>0),
  rows bigint NOT NULL CHECK(rows>=0),
  accepted bigint NOT NULL CHECK(accepted>=0 AND accepted<=rows),
  errors jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(errors)='array' AND jsonb_array_length(errors)<=100),
  manifest_hash varchar(64),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(run_id,upload_id)
);
CREATE INDEX liekan_warehouse_repair_upload_current ON liekan_warehouse_repair_upload(run_id,rulepack_hash,state,created_at);
