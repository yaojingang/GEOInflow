SET LOCAL lock_timeout='2s';
-- Drain marker writers before installing the additional transactional capture.
LOCK TABLE liekan_analysis_dirty,liekan_dashboard_dirty IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE liekan_analytics_input_summary (
 website_id uuid NOT NULL REFERENCES liekan_analysis_site(website_id) ON DELETE CASCADE,
 epoch bigint NOT NULL,
 source text NOT NULL CHECK(source IN('coarse','fine')),
 family text NOT NULL CHECK((source='coarse' AND family IN('log','visit')) OR (source='fine' AND family='detail')),
 day timestamptz NOT NULL CHECK(isfinite(day) AND day=date_bin(interval '1 day',day,timestamptz '2000-01-01Z')),
 shard smallint NOT NULL CHECK(shard BETWEEN 0 AND 31),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 PRIMARY KEY(website_id,epoch,source,family,day,shard)
);
-- Writers use 32 transaction shards; this progress row is owned by maintenance.
CREATE TABLE liekan_analytics_input_state (
 website_id uuid NOT NULL REFERENCES liekan_analysis_site(website_id) ON DELETE CASCADE,
 epoch bigint NOT NULL,
 generation uuid NOT NULL DEFAULT gen_random_uuid(),
 ready boolean NOT NULL DEFAULT false,
 source smallint NOT NULL DEFAULT 0 CHECK(source BETWEEN 0 AND 2),
 cursor_family text NOT NULL DEFAULT '',
 cursor_bucket timestamptz NOT NULL DEFAULT '-infinity',
 cursor_shard smallint NOT NULL DEFAULT -1,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(website_id,epoch)
);
CREATE FUNCTION liekan_analytics_input_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin text; writer_shard smallint;
BEGIN
 origin:=CASE TG_TABLE_NAME WHEN 'liekan_analysis_dirty' THEN 'coarse' ELSE 'fine' END;
 IF TG_OP='UPDATE' THEN
  IF NOT EXISTS(SELECT 1 FROM new_markers WHERE isfinite(bucket) AND (origin='coarse' OR family='detail'))
   AND NOT EXISTS(SELECT 1 FROM old_markers WHERE isfinite(bucket) AND (origin='coarse' OR family='detail')) THEN
   RETURN NULL;
  END IF;
  writer_shard:=(txid_current()%32)::smallint;
  INSERT INTO liekan_analytics_input_summary(website_id,epoch,source,family,day,shard,revision)
   SELECT website_id,epoch,origin,family,date_bin(interval '1 day',bucket,timestamptz '2000-01-01Z'),writer_shard,count(*)
   FROM (
    (SELECT website_id,epoch,family,bucket,shard,revision FROM old_markers EXCEPT SELECT website_id,epoch,family,bucket,shard,revision FROM new_markers)
    UNION (SELECT website_id,epoch,family,bucket,shard,revision FROM new_markers EXCEPT SELECT website_id,epoch,family,bucket,shard,revision FROM old_markers)
   ) r WHERE isfinite(bucket) AND (origin='coarse' OR family='detail')
   GROUP BY website_id,epoch,family,5 ORDER BY website_id,epoch,family,5
   ON CONFLICT(website_id,epoch,source,family,day,shard) DO UPDATE
    SET revision=liekan_analytics_input_summary.revision+EXCLUDED.revision;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM new_markers WHERE isfinite(bucket) AND (origin='coarse' OR family='detail')) THEN
   RETURN NULL;
  END IF;
  writer_shard:=(txid_current()%32)::smallint;
  INSERT INTO liekan_analytics_input_summary(website_id,epoch,source,family,day,shard,revision)
   SELECT website_id,epoch,origin,family,date_bin(interval '1 day',bucket,timestamptz '2000-01-01Z'),writer_shard,count(*)
   FROM new_markers WHERE isfinite(bucket) AND (origin='coarse' OR family='detail')
   GROUP BY website_id,epoch,family,5 ORDER BY website_id,epoch,family,5
   ON CONFLICT(website_id,epoch,source,family,day,shard) DO UPDATE
    SET revision=liekan_analytics_input_summary.revision+EXCLUDED.revision;
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION liekan_analytics_input_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' THEN
  INSERT INTO liekan_analytics_input_state(website_id,epoch)
   SELECT website_id,epoch FROM liekan_analysis_site WHERE mode='live'
   ON CONFLICT(website_id,epoch) DO UPDATE SET ready=false,generation=gen_random_uuid(),source=0,
    cursor_family='',cursor_bucket='-infinity',cursor_shard=-1,updated_at=clock_timestamp();
 ELSE
  INSERT INTO liekan_analytics_input_state(website_id,epoch)
   SELECT DISTINCT r.website_id,r.epoch FROM removed_markers r
   JOIN liekan_analysis_site s ON s.website_id=r.website_id AND s.epoch=r.epoch
   ORDER BY r.website_id,r.epoch
   ON CONFLICT(website_id,epoch) DO UPDATE SET ready=false,generation=gen_random_uuid(),source=0,
    cursor_family='',cursor_bucket='-infinity',cursor_shard=-1,updated_at=clock_timestamp();
 END IF;
 RETURN NULL;
END $$;
-- Direct maintenance may replace a token with an earlier revision. Fence that write
-- while nested marker capture continues to update only its daily writer shards.
CREATE FUNCTION liekan_analytics_input_summary_updated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF pg_trigger_depth()<>1 THEN RETURN NULL; END IF;
 INSERT INTO liekan_analytics_input_state(website_id,epoch)
 SELECT DISTINCT r.website_id,r.epoch FROM (
  (SELECT * FROM old_markers EXCEPT SELECT * FROM new_markers)
  UNION (SELECT * FROM new_markers EXCEPT SELECT * FROM old_markers)
 ) r JOIN liekan_analysis_site s ON s.website_id=r.website_id AND s.epoch=r.epoch
 ORDER BY r.website_id,r.epoch
 ON CONFLICT(website_id,epoch) DO UPDATE SET ready=false,generation=gen_random_uuid(),source=0,
  cursor_family='',cursor_bucket='-infinity',cursor_shard=-1,updated_at=clock_timestamp();
 RETURN NULL;
END $$;
CREATE TRIGGER analytics_input_update AFTER UPDATE ON liekan_analytics_input_summary
 REFERENCING OLD TABLE AS old_markers NEW TABLE AS new_markers
 FOR EACH STATEMENT EXECUTE FUNCTION liekan_analytics_input_summary_updated();
DO $$ DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['liekan_analysis_dirty','liekan_dashboard_dirty'] LOOP
  EXECUTE format('CREATE TRIGGER analytics_input_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_markers FOR EACH STATEMENT EXECUTE FUNCTION liekan_analytics_input_capture()',relation);
  EXECUTE format('CREATE TRIGGER analytics_input_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_markers NEW TABLE AS new_markers FOR EACH STATEMENT EXECUTE FUNCTION liekan_analytics_input_capture()',relation);
 END LOOP;
 FOREACH relation IN ARRAY ARRAY['liekan_analysis_dirty','liekan_dashboard_dirty','liekan_analytics_input_summary'] LOOP
  EXECUTE format('CREATE TRIGGER analytics_input_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS removed_markers FOR EACH STATEMENT EXECUTE FUNCTION liekan_analytics_input_removed()',relation);
  EXECUTE format('CREATE TRIGGER analytics_input_truncate AFTER TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION liekan_analytics_input_removed()',relation);
 END LOOP;
END $$;

-- Every batch advances through at most 2048 original marker keys. Transactional capture
-- covers new earlier keys and concurrent updates, including already traversed days.
CREATE FUNCTION liekan_analytics_input_backfill(site_id uuid DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE site uuid; epoch_id bigint; progress liekan_analytics_input_state%ROWTYPE;
 relation text; total integer; last_family text; last_bucket timestamptz; last_shard smallint;
BEGIN
 -- Site authority is locked before progress, matching lifecycle and deletion order.
 SELECT s.website_id,s.epoch INTO site,epoch_id FROM liekan_analysis_site s
 WHERE s.mode='live' AND (site_id IS NULL OR s.website_id=site_id)
 AND NOT EXISTS(SELECT 1 FROM liekan_analytics_input_state p
  WHERE p.website_id=s.website_id AND p.epoch=s.epoch AND p.ready)
 ORDER BY (SELECT p.updated_at FROM liekan_analytics_input_state p WHERE p.website_id=s.website_id AND p.epoch=s.epoch) NULLS FIRST,s.website_id
 LIMIT 1 FOR SHARE OF s SKIP LOCKED;
 IF NOT FOUND THEN RETURN 0; END IF;
 INSERT INTO liekan_analytics_input_state(website_id,epoch) VALUES(site,epoch_id) ON CONFLICT DO NOTHING;
 SELECT * INTO progress FROM liekan_analytics_input_state
 WHERE website_id=site AND epoch=epoch_id FOR UPDATE SKIP LOCKED;
 IF NOT FOUND OR progress.ready THEN RETURN 0; END IF;
 relation:=CASE progress.source WHEN 0 THEN 'liekan_analysis_dirty' ELSE 'liekan_dashboard_dirty' END;
 EXECUTE format('WITH marks AS MATERIALIZED (
  SELECT family,bucket,shard FROM %I WHERE website_id=$1 AND epoch=$2
   AND ($3=0 OR family=''detail'') AND (family,bucket,shard)>($4,$5,$6)
  ORDER BY family,bucket,shard LIMIT 2048
 ),filled AS (
  INSERT INTO liekan_analytics_input_summary(website_id,epoch,source,family,day,shard)
  SELECT $1,$2,CASE $3 WHEN 0 THEN ''coarse'' ELSE ''fine'' END,family,
   date_bin(interval ''1 day'',bucket,timestamptz ''2000-01-01Z''),shard FROM marks WHERE isfinite(bucket)
  GROUP BY family,5,shard ORDER BY family,5,shard ON CONFLICT DO NOTHING RETURNING 1
 ) SELECT count(*)::integer,
  (SELECT family FROM marks ORDER BY family DESC,bucket DESC,shard DESC LIMIT 1),
  (SELECT bucket FROM marks ORDER BY family DESC,bucket DESC,shard DESC LIMIT 1),
  (SELECT shard FROM marks ORDER BY family DESC,bucket DESC,shard DESC LIMIT 1) FROM marks',relation)
 INTO total,last_family,last_bucket,last_shard
 USING site,epoch_id,progress.source,progress.cursor_family,progress.cursor_bucket,progress.cursor_shard;
 IF total<2048 THEN
  UPDATE liekan_analytics_input_state SET source=progress.source+1,ready=(progress.source=1),
   cursor_family='',cursor_bucket='-infinity',cursor_shard=-1,updated_at=clock_timestamp()
  WHERE website_id=site AND epoch=epoch_id AND generation=progress.generation;
 ELSE
  UPDATE liekan_analytics_input_state SET cursor_family=last_family,cursor_bucket=last_bucket,
   cursor_shard=last_shard,updated_at=clock_timestamp()
  WHERE website_id=site AND epoch=epoch_id AND generation=progress.generation;
 END IF;
 RETURN total;
END $$;

CREATE FUNCTION liekan_dashboard_fingerprint_v2(site uuid,epoch_id bigint,ends timestamptz)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE generation_id uuid; summary_ready boolean; log_end timestamptz; visit_end timestamptz;
 log_day timestamptz; visit_day timestamptz; detail_day timestamptz; digest text;
BEGIN
 SELECT p.generation,p.ready INTO generation_id,summary_ready FROM liekan_analytics_input_state p
 JOIN liekan_analysis_site s ON s.website_id=p.website_id AND s.epoch=p.epoch AND s.mode='live'
 WHERE p.website_id=site AND p.epoch=epoch_id;
 IF generation_id IS NULL OR NOT summary_ready OR ends IS NULL OR NOT isfinite(ends) THEN
  RETURN 'input-summary-v1:legacy:'||coalesce(generation_id::text,'pending')||':'||liekan_dashboard_fingerprint(site,epoch_id,ends);
 END IF;
 log_end:=date_bin(interval '5 minutes',ends,timestamptz '2000-01-01Z');
 visit_end:=date_bin(interval '1 hour',ends,timestamptz '2000-01-01Z');
 log_day:=date_bin(interval '1 day',log_end,timestamptz '2000-01-01Z');
 visit_day:=date_bin(interval '1 day',visit_end,timestamptz '2000-01-01Z');
 detail_day:=date_bin(interval '1 day',ends,timestamptz '2000-01-01Z');
 WITH tokens AS (
  SELECT 'day:'||source||':'||family AS kind,day AS bucket,shard,revision
   FROM liekan_analytics_input_summary WHERE website_id=site AND epoch=epoch_id AND source='coarse' AND family='log' AND day<log_day
  UNION ALL SELECT 'day:'||source||':'||family,day,shard,revision
   FROM liekan_analytics_input_summary WHERE website_id=site AND epoch=epoch_id AND source='coarse' AND family='visit' AND day<visit_day
  UNION ALL SELECT 'day:'||source||':'||family,day,shard,revision
   FROM liekan_analytics_input_summary WHERE website_id=site AND epoch=epoch_id AND source='fine' AND family='detail' AND day<detail_day
  UNION ALL SELECT 'coarse:'||family,bucket,shard,revision FROM liekan_analysis_dirty
   WHERE website_id=site AND epoch=epoch_id AND family='log' AND bucket>=log_day AND bucket<log_end
  UNION ALL SELECT 'coarse:'||family,bucket,shard,revision FROM liekan_analysis_dirty
   WHERE website_id=site AND epoch=epoch_id AND family='visit' AND bucket>=visit_day AND bucket<visit_end
  UNION ALL SELECT 'coarse:'||family,bucket,shard,revision FROM liekan_analysis_dirty
   WHERE website_id=site AND epoch=epoch_id AND family='log' AND bucket='-infinity'
  UNION ALL SELECT 'coarse:'||family,bucket,shard,revision FROM liekan_analysis_dirty
   WHERE website_id=site AND epoch=epoch_id AND family='visit' AND bucket='-infinity'
  UNION ALL SELECT 'fine:'||family,bucket,shard,revision FROM liekan_dashboard_dirty
   WHERE website_id=site AND epoch=epoch_id AND family='detail' AND bucket>=detail_day AND bucket<ends
  UNION ALL SELECT 'fine:'||family,bucket,shard,revision FROM liekan_dashboard_dirty
   WHERE website_id=site AND epoch=epoch_id AND family='visit' AND bucket>=visit_end AND bucket<ends
  UNION ALL SELECT 'fine:'||family,bucket,shard,revision FROM liekan_dashboard_dirty
   WHERE website_id=site AND epoch=epoch_id AND family='log' AND bucket>=log_end AND bucket<ends
  UNION ALL SELECT 'fine:'||family,bucket,shard,revision FROM liekan_dashboard_dirty
   WHERE website_id=site AND epoch=epoch_id AND family='log' AND bucket='-infinity'
  UNION ALL SELECT 'fine:'||family,bucket,shard,revision FROM liekan_dashboard_dirty
   WHERE website_id=site AND epoch=epoch_id AND family='visit' AND bucket='-infinity'
  UNION ALL SELECT 'fine:'||family,bucket,shard,revision FROM liekan_dashboard_dirty
   WHERE website_id=site AND epoch=epoch_id AND family='detail' AND bucket='-infinity'
 ) SELECT encode(sha256(convert_to(coalesce(string_agg(kind||':'||extract(epoch FROM bucket)::text||':'||shard::text||':'||revision::text,',' ORDER BY kind,bucket,shard),''),'UTF8')),'hex') INTO digest FROM tokens;
 RETURN 'input-summary-v1:'||generation_id::text||':'||digest;
END $$;
DO $$ DECLARE routine text;
BEGIN
 FOREACH routine IN ARRAY ARRAY['liekan_analytics_input_capture()','liekan_analytics_input_removed()','liekan_analytics_input_summary_updated()',
  'liekan_analytics_input_backfill(uuid)','liekan_dashboard_fingerprint_v2(uuid,bigint,timestamptz)'] LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path TO %I,pg_temp',routine,current_schema());
 END LOOP;
END $$;
