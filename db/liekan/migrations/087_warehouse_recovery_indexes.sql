-- Lookup/reclamation uses stable operation references, not scans of all work.
DROP INDEX liekan_warehouse_work_reclaim;
CREATE INDEX liekan_warehouse_work_attempt ON liekan_warehouse_work(attempt_id) WHERE attempt_id IS NOT NULL;
CREATE INDEX liekan_warehouse_candidate_attempt ON liekan_warehouse_candidate(attempt_id);
CREATE INDEX liekan_warehouse_task_active_attempt ON liekan_warehouse_task(attempt_id) WHERE status IN('pending','confirmed');
