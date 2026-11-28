-- Existing receipts have no proven event time; leave their lower bound unknown.
ALTER TABLE liekan_ingest_batch ADD COLUMN min_event_at timestamptz;
