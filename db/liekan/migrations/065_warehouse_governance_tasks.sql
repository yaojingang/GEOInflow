-- Preview memberships live in CH; PG retains the approval and durable task reference.
ALTER TABLE liekan_warehouse_task DROP CONSTRAINT liekan_warehouse_task_kind_check;
ALTER TABLE liekan_warehouse_task ADD CONSTRAINT liekan_warehouse_task_kind_check
  CHECK(kind IN ('browser-risk','traffic-exclusion'));
DROP INDEX liekan_warehouse_task_active_scope;
CREATE UNIQUE INDEX liekan_warehouse_task_active_risk ON liekan_warehouse_task(website_id,kind)
  WHERE status IN ('pending','confirmed') AND kind='browser-risk';
CREATE UNIQUE INDEX liekan_warehouse_task_active_scope ON liekan_warehouse_task(website_id,kind,scope_key)
  WHERE status IN ('pending','confirmed');
