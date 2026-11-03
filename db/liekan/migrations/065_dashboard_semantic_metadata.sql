SET LOCAL lock_timeout='2s';
-- Permission checks and delivery leases do not change report evidence.
CREATE OR REPLACE FUNCTION liekan_dashboard_metadata_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rows_sql text; projection text;
BEGIN
 IF TG_OP='UPDATE' THEN
  projection:=CASE TG_TABLE_NAME
   WHEN 'liekan_log_source' THEN 'jsonb_build_array(website_id,id,state)'
   WHEN 'liekan_browser_risk_state' THEN 'jsonb_build_array(website_id,epoch,computed_at,next_window,error_code)'
   ELSE 'to_jsonb(t)' END;
  rows_sql:=format('(SELECT website_id,%1$s AS evidence FROM old_rows t EXCEPT SELECT website_id,%1$s FROM new_rows t)
   UNION ALL (SELECT website_id,%1$s FROM new_rows t EXCEPT SELECT website_id,%1$s FROM old_rows t)',projection);
 ELSE
  rows_sql:=CASE TG_OP WHEN 'INSERT' THEN 'SELECT website_id FROM new_rows' ELSE 'SELECT website_id FROM old_rows' END;
 END IF;
 EXECUTE format('INSERT INTO liekan_dashboard_dirty(website_id,epoch,family,bucket,shard)
  SELECT DISTINCT r.website_id,s.epoch,''detail'',''-infinity''::timestamptz,0 FROM (%s) r
  JOIN liekan_analysis_site s ON s.website_id=r.website_id AND s.mode=''live''
  ON CONFLICT(website_id,epoch,family,bucket,shard) DO UPDATE SET revision=liekan_dashboard_dirty.revision+1',rows_sql);
 RETURN NULL;
END $$;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION liekan_dashboard_metadata_capture() SET search_path TO %I,pg_temp',current_schema());
END $$;
