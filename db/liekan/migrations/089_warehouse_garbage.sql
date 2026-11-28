-- Durable cleanup intent precedes deletion of the PG recovery metadata. These
-- candidates were never selected for publication. Accepted facts and receipts
-- are not subject to an implicit age/size limit.
CREATE TABLE liekan_warehouse_garbage (
  candidate_id uuid PRIMARY KEY,
  website_id uuid NOT NULL,
  epoch bigint NOT NULL,
  family text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX liekan_warehouse_garbage_pending ON liekan_warehouse_garbage(created_at,candidate_id)
  WHERE completed_at IS NULL;
