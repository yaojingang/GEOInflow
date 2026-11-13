-- Enable only after queue-first intake and maintenance fences are installed.
-- This prevents an old worker from silently adding un-captured PG facts.
ALTER TABLE liekan_warehouse_installation ADD COLUMN facts_fenced boolean NOT NULL DEFAULT false;
CREATE FUNCTION liekan_warehouse_fact_writer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_authority text; fenced boolean; writer text; active_transition boolean;
BEGIN
  SELECT authority,facts_fenced INTO current_authority,fenced
    FROM liekan_warehouse_installation WHERE id=1 FOR SHARE;
  IF NOT FOUND OR NOT fenced THEN RETURN NULL; END IF;
  writer=current_setting('liekan.warehouse_writer',true);
  SELECT EXISTS(SELECT 1 FROM liekan_warehouse_transition WHERE id=1 AND state IN('capturing','frozen','draining')) INTO active_transition;
  IF writer='postgres-authority' AND current_authority='postgres' THEN RETURN NULL; END IF;
  IF writer='postgres-replica' AND current_authority IN('clickhouse','frozen') AND active_transition THEN RETURN NULL; END IF;
  IF writer='lifecycle' AND TG_OP='DELETE' AND current_authority IN('postgres','clickhouse','frozen') THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'warehouse-postgres-fact-writer-fenced' USING ERRCODE='55000';
END $$;
DO $$
DECLARE family text;
BEGIN
  FOREACH family IN ARRAY ARRAY[
    'event_data','heatmap_event','liekan_browser_risk','liekan_collection_diagnostic','liekan_collection_receipt',
    'liekan_crawler_evidence','liekan_event_environment','liekan_event_geography','liekan_event_observation',
    'liekan_event_quality','liekan_geography_ingress','liekan_history_repair_input','liekan_history_repair_result',
    'liekan_history_repair_visitor','liekan_log','liekan_log_geography','liekan_session_data_source',
    'liekan_session_link_source','liekan_session_source','liekan_traffic_exclusion_member','revenue','session',
    'session_data','session_link','session_replay','website_event'] LOOP
    EXECUTE format('CREATE TRIGGER liekan_warehouse_fact_writer_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I
      FOR EACH STATEMENT EXECUTE FUNCTION liekan_warehouse_fact_writer_guard()',family);
  END LOOP;
END $$;
