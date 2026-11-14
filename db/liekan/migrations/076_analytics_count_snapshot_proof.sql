-- Invalidate derived results that could predate snapshot-bound count verification.
INSERT INTO liekan_analytics_revision(resource_type,resource_id,revision)
SELECT 'website',w.website_id,1 FROM website w
WHERE w.deleted_at IS NULL AND EXISTS (
 SELECT 1 FROM liekan_analytics_engine_unit u WHERE u.website_id=w.website_id AND u.generation IS NOT NULL
)
ON CONFLICT(resource_type,resource_id) DO UPDATE
 SET revision=liekan_analytics_revision.revision+1,updated_at=clock_timestamp();

-- Retain raw generations and source authority while renewing independent count proofs.
UPDATE liekan_analytics_engine_unit SET counts_generation=NULL,counts_version=NULL,
 counts_checksum=NULL,counts_verified_at=NULL,attempts=0,retry_at=NULL,error_code=NULL,
 lease_token=NULL,lease_until=NULL WHERE generation IS NOT NULL;
