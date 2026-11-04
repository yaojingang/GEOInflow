-- Temporary PG-authoritative processing uses the same queued input references.
-- Only response identity/status is added; payload remains in the migration journal.
ALTER TABLE liekan_warehouse_work ADD COLUMN result_status text
  CHECK(result_status IN('new','duplicate','conflict','cancelled'));
ALTER TABLE liekan_warehouse_work ADD COLUMN result_session_id uuid;
ALTER TABLE liekan_warehouse_work ADD COLUMN result_visit_id uuid;
