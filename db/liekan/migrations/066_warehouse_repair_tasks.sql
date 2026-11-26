ALTER TABLE liekan_warehouse_task DROP CONSTRAINT liekan_warehouse_task_kind_check;
ALTER TABLE liekan_warehouse_task ADD CONSTRAINT liekan_warehouse_task_kind_check
  CHECK(kind IN ('browser-risk','traffic-exclusion','history-repair-batch'));
