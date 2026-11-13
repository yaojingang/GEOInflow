CREATE TABLE liekan_warehouse_repair_continuation (
  run_id uuid NOT NULL REFERENCES liekan_history_repair_run(id) ON DELETE CASCADE,
  step_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, step_id)
);
