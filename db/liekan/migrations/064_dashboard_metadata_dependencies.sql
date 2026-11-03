SET LOCAL lock_timeout='2s';
-- These control rows affect connection state, catalog display or population processing evidence.
CREATE FUNCTION liekan_dashboard_metadata_capture() RETURNS trigger LANGUAGE plpgsql AS $$
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
DO $$ DECLARE relation text;
BEGIN
 EXECUTE format('ALTER FUNCTION liekan_dashboard_metadata_capture() SET search_path TO %I,pg_temp',current_schema());
 FOREACH relation IN ARRAY ARRAY['liekan_browser_risk_state','liekan_log_source','liekan_log_interval','liekan_catalog'] LOOP
  EXECUTE format('CREATE TRIGGER snapshot_metadata_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION liekan_dashboard_metadata_capture()',relation);
  EXECUTE format('CREATE TRIGGER snapshot_metadata_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION liekan_dashboard_metadata_capture()',relation);
  EXECUTE format('CREATE TRIGGER snapshot_metadata_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION liekan_dashboard_metadata_capture()',relation);
 END LOOP;
END $$;
UPDATE liekan_dashboard_snapshot SET fingerprint=NULL,next_refresh_at=clock_timestamp(),error_code='dashboard-dependencies-changed'
 WHERE target='feature:page-report' AND parameters->>'resource' IN('overview','human/overview') AND result IS NOT NULL;
