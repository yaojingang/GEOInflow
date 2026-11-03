SET LOCAL lock_timeout='2s';
ALTER TABLE liekan_storage_candidate ALTER COLUMN queue_name SET DEFAULT '';
UPDATE liekan_storage_candidate SET queue_name='' WHERE queue_name IS NULL;
ALTER TABLE liekan_storage_candidate ALTER COLUMN queue_name SET NOT NULL;
ALTER TABLE liekan_storage_candidate DROP CONSTRAINT liekan_storage_candidate_pkey;
ALTER TABLE liekan_storage_candidate ADD PRIMARY KEY(run_id,kind,queue_name,record_id);
