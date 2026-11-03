SET LOCAL lock_timeout='2s';
-- Import counters and connection presence can change without a new log row.
CREATE FUNCTION liekan_dashboard_import_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rows_sql text;
BEGIN
 rows_sql:=CASE TG_OP WHEN 'INSERT' THEN 'SELECT * FROM new_rows' WHEN 'DELETE' THEN 'SELECT * FROM old_rows'
  ELSE 'SELECT * FROM old_rows UNION ALL SELECT * FROM new_rows' END;
 EXECUTE format('INSERT INTO liekan_dashboard_dirty(website_id,epoch,family,bucket,shard)
  SELECT DISTINCT r.website_id,s.epoch,''detail'',''-infinity''::timestamptz,0 FROM (%s) r
  JOIN liekan_analysis_site s ON s.website_id=r.website_id AND s.mode=''live''
  ON CONFLICT(website_id,epoch,family,bucket,shard) DO UPDATE SET revision=liekan_dashboard_dirty.revision+1',rows_sql);
 RETURN NULL;
END $$;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION liekan_dashboard_import_capture() SET search_path TO %I,pg_temp',current_schema());
END $$;
CREATE TRIGGER snapshot_import_insert AFTER INSERT ON liekan_import REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION liekan_dashboard_import_capture();
CREATE TRIGGER snapshot_import_update AFTER UPDATE ON liekan_import REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION liekan_dashboard_import_capture();
CREATE TRIGGER snapshot_import_delete AFTER DELETE ON liekan_import REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION liekan_dashboard_import_capture();
UPDATE liekan_dashboard_snapshot SET fingerprint=NULL,next_refresh_at=clock_timestamp(),error_code='dashboard-dependencies-changed'
 WHERE target='feature:page-report' AND parameters->>'resource' IN('overview','human/overview') AND result IS NOT NULL;
