SET LOCAL lock_timeout='2s';
-- A failed producer stays bounded until its source, coverage or capacity changes.
ALTER TABLE liekan_dashboard_snapshot ADD COLUMN attempt_fingerprint text;
