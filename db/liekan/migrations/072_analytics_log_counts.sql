-- Independent proofs for exact hourly counts; existing raw projection versions remain valid.
ALTER TABLE liekan_analytics_engine_unit
 ADD COLUMN counts_version text,
 ADD COLUMN counts_checksum text,
 ADD COLUMN counts_verified_at timestamptz;
CREATE INDEX liekan_engine_pending_counts ON liekan_analytics_engine_unit(bucket,website_id)
 WHERE counts_verified_at IS NULL;
