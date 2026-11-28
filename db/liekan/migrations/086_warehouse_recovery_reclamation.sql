ALTER TABLE liekan_warehouse_partition ADD COLUMN reclaimed_offset bigint NOT NULL DEFAULT -1;
ALTER TABLE liekan_warehouse_partition ADD CONSTRAINT liekan_warehouse_reclaim_safe CHECK(reclaimed_offset BETWEEN -1 AND safe_offset);
CREATE INDEX liekan_warehouse_work_reclaim ON liekan_warehouse_work(topic_id,partition,offset_id,updated_at);
CREATE INDEX liekan_warehouse_attempt_reclaim ON liekan_warehouse_attempt(updated_at) WHERE status IN('projected','aborted');
