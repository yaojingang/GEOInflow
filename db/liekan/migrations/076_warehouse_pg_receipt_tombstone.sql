-- Temporary PG authority remembers the canonical session of deleted UUID
-- receipts until queued pre-deletion inputs and the rollback window drain.
CREATE TABLE liekan_warehouse_pg_receipt_tombstone (
  operation_id uuid NOT NULL REFERENCES liekan_warehouse_deletion(operation_id),
  website_id uuid NOT NULL,
  client_event_id uuid NOT NULL,
  session_id uuid,
  PRIMARY KEY(operation_id,client_event_id)
);
CREATE INDEX liekan_warehouse_pg_receipt_tombstone_lookup
  ON liekan_warehouse_pg_receipt_tombstone(website_id,client_event_id);
