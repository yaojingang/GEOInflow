-- Exact module dependencies retain unrelated historical publications.
CREATE FUNCTION liekan_report_range_fingerprint(site uuid,epoch_id bigint,kind text,starts timestamptz,ends timestamptz)
RETURNS text LANGUAGE sql STABLE AS $$
 WITH progress AS (
  SELECT generation,ready FROM liekan_analytics_input_state WHERE website_id=site AND epoch=epoch_id
 ),bounds AS (
  SELECT date_bin(CASE kind WHEN 'log' THEN interval '5 minutes' ELSE interval '1 hour' END,starts,timestamptz '2000-01-01Z') AS coarse_start,
   date_bin(CASE kind WHEN 'log' THEN interval '5 minutes' ELSE interval '1 hour' END,ends,timestamptz '2000-01-01Z') AS coarse_end,
   date_bin(interval '30 seconds',starts,timestamptz '2000-01-01Z') AS fine_start,
   date_bin(interval '1 day',starts-interval '1 microsecond',timestamptz '2000-01-01Z')+interval '1 day' AS day_start,
   date_bin(interval '1 day',ends,timestamptz '2000-01-01Z') AS day_end,
   coalesce((SELECT ready FROM progress),false) AS ready
 ),tokens AS (
  SELECT 'day' AS source,d.day AS bucket,d.shard,d.revision FROM liekan_analytics_input_summary d,bounds b
   WHERE d.website_id=site AND d.epoch=epoch_id AND d.source='coarse' AND d.family=kind AND b.ready
    AND d.day>=b.day_start AND d.day<b.day_end
  UNION ALL
  SELECT 'coarse' AS source,d.bucket,d.shard,d.revision FROM liekan_analysis_dirty d,bounds b
   WHERE d.website_id=site AND d.epoch=epoch_id AND d.family=kind
    AND (d.bucket='-infinity' OR (d.bucket>=b.coarse_start AND d.bucket<b.coarse_end
     AND (NOT b.ready OR d.bucket<b.day_start OR d.bucket>=b.day_end)))
  UNION ALL
  SELECT 'fine',d.bucket,d.shard,d.revision FROM liekan_dashboard_dirty d,bounds b
   WHERE d.website_id=site AND d.epoch=epoch_id AND d.family=kind
    AND (d.bucket='-infinity' OR (d.bucket>=greatest(b.fine_start,b.coarse_end) AND d.bucket<ends))
 ) SELECT 'report-range-v1:'||coalesce((SELECT generation::text||':'||ready::text FROM progress),'pending')||':'||encode(sha256(convert_to(coalesce(string_agg(source||':'||extract(epoch FROM bucket)::text||':'||shard::text||':'||revision::text,',' ORDER BY source,bucket,shard),''),'UTF8')),'hex') FROM tokens
$$;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION liekan_report_range_fingerprint(uuid,bigint,text,timestamptz,timestamptz) SET search_path TO %I,pg_temp',current_schema());
END $$;

-- A default build receives one turn after two foreground units and thirty seconds of waiting.
ALTER TABLE liekan_analysis_background_lease ADD COLUMN default_turns integer NOT NULL DEFAULT 0;
ALTER TABLE liekan_dashboard_snapshot ADD COLUMN registered_at timestamptz NOT NULL DEFAULT clock_timestamp();
