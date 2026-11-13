-- Queue offsets without a valid product identity remain retained and visible to
-- operations. Storing the source reference never stores an untrusted payload.
CREATE TABLE liekan_warehouse_queue_fault (
  topic_id text NOT NULL,
  partition integer NOT NULL,
  offset_id bigint NOT NULL CHECK (offset_id >= 0),
  reason text NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(topic_id,partition,offset_id),
  FOREIGN KEY(topic_id,partition) REFERENCES liekan_warehouse_partition(topic_id,partition)
);
CREATE INDEX liekan_warehouse_work_key_pending
  ON liekan_warehouse_work(topic_id,identity_key,offset_id)
  WHERE status IN ('pending','working','quarantined');
CREATE INDEX liekan_warehouse_work_site_pending
  ON liekan_warehouse_work(topic_id,partition,website_id,offset_id)
  WHERE status='pending';
