SET LOCAL lock_timeout='2s';
CREATE FUNCTION liekan_storage_complete_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state::text='completed' AND NEW.name=ANY(ARRAY[
  'liekan-crawler-control','liekan-crawler-check','liekan-crawler-analysis','liekan-browser-risk',
  'liekan-analysis-query','liekan-analysis-build','liekan-analytics-refresh',
  'liekan-geo-weight-snapshot','liekan-range-refresh','liekan-crawler-documents'])
 THEN NEW.deletion_seconds:=0; END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF to_regclass('liekan_jobs.job') IS NOT NULL THEN
  EXECUTE format('CREATE OR REPLACE TRIGGER liekan_completed_policy_owner BEFORE UPDATE OF state ON liekan_jobs.job FOR EACH ROW EXECUTE FUNCTION %I.liekan_storage_complete_job()',current_schema());
 END IF;
END $$;
