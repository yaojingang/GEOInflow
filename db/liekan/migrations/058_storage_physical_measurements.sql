SET LOCAL lock_timeout='2s';
ALTER TABLE liekan_storage_cleanup ADD COLUMN physical_bytes_before bigint;
ALTER TABLE liekan_storage_cleanup ADD COLUMN physical_bytes_after bigint;
