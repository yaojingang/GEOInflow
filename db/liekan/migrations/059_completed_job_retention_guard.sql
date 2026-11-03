SET LOCAL lock_timeout='2s';
CREATE FUNCTION liekan_storage_guard_completed_job() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE cleanup uuid;
BEGIN
 IF OLD.state::text<>'completed' OR OLD.name<>ALL(ARRAY[
  'liekan-crawler-control','liekan-crawler-check','liekan-crawler-analysis','liekan-browser-risk',
  'liekan-analysis-query','liekan-analysis-build','liekan-analytics-refresh',
  'liekan-geo-weight-snapshot','liekan-range-refresh','liekan-crawler-documents']) THEN RETURN OLD; END IF;
 BEGIN
  cleanup:=nullif(current_setting('liekan.storage_cleanup_run',true),'')::uuid;
 EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
 END;
 IF cleanup IS NOT NULL AND EXISTS(
  SELECT 1 FROM liekan_storage_candidate c JOIN liekan_storage_cleanup r ON r.id=c.run_id
  WHERE c.run_id=cleanup AND c.kind='job' AND c.record_id=OLD.id AND c.queue_name=OLD.name
   AND r.website_id IS NULL AND r.scope_key='instance' AND r.status IN('queued','running')
 ) THEN RETURN OLD; END IF;
 RETURN NULL;
END $$;
DO $$ BEGIN
 IF to_regclass('liekan_jobs.job') IS NOT NULL THEN
  EXECUTE format('CREATE OR REPLACE TRIGGER liekan_completed_retention_guard BEFORE DELETE ON liekan_jobs.job FOR EACH ROW EXECUTE FUNCTION %I.liekan_storage_guard_completed_job()',current_schema());
 END IF;
END $$;
