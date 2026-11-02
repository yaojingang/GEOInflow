-- ClickHouse keeps rebuildable historical projections. PostgreSQL publishes their authority.
CREATE TABLE liekan_analytics_engine (
 id integer PRIMARY KEY CHECK(id=1), installation_id uuid NOT NULL DEFAULT gen_random_uuid(), revision bigint NOT NULL DEFAULT 0,
 enabled boolean NOT NULL DEFAULT false, syncing boolean NOT NULL DEFAULT false,
 capture boolean NOT NULL DEFAULT false, epoch bigint NOT NULL DEFAULT 1,
 actor_id uuid, connection_hash text, checked_at timestamptz, version text, gc_cursor uuid,
 maintenance_turn smallint NOT NULL DEFAULT 0 CHECK(maintenance_turn BETWEEN 0 AND 7),
 healthy boolean NOT NULL DEFAULT false, worker_at timestamptz, error_code text,
 locale text NOT NULL DEFAULT 'zh-CN' CHECK(locale IN('zh-CN','en-US'))
);
INSERT INTO liekan_analytics_engine(id) VALUES(1);
CREATE TABLE liekan_analytics_engine_site (
 website_id uuid PRIMARY KEY, epoch bigint NOT NULL DEFAULT 1,
 revision bigint NOT NULL DEFAULT 0, history_cursor timestamptz, history_start timestamptz, history_end timestamptz, discovered_at timestamptz,
 purge_token uuid, purge_until timestamptz, seen_versions jsonb, control_epoch bigint NOT NULL DEFAULT 0, served_at timestamptz,
 targets text[] NOT NULL DEFAULT '{}', pending_targets text[] NOT NULL DEFAULT '{}', sweep_targets text[] NOT NULL DEFAULT '{}',
 purge_through bigint NOT NULL DEFAULT 0, purge_checked_at timestamptz,
 purge_pending boolean NOT NULL DEFAULT false
);
CREATE TABLE liekan_analytics_engine_dirty (
 website_id uuid NOT NULL REFERENCES liekan_analytics_engine_site ON DELETE CASCADE,
 bucket timestamptz NOT NULL, shard smallint NOT NULL CHECK(shard>=0 AND shard<32),
 revision bigint NOT NULL DEFAULT 1, pending boolean NOT NULL DEFAULT true, PRIMARY KEY(website_id,bucket,shard)
);
CREATE INDEX liekan_engine_pending_dirty ON liekan_analytics_engine_dirty(bucket,website_id) WHERE pending;
CREATE TABLE liekan_analytics_engine_unit (
 website_id uuid NOT NULL REFERENCES liekan_analytics_engine_site ON DELETE CASCADE,
 bucket timestamptz NOT NULL, generation uuid, active_epoch bigint,
 versions jsonb, fingerprint text, row_count bigint NOT NULL DEFAULT 0,
 checksum text, published_at timestamptz, verified_at timestamptz,
 candidate uuid, candidate_versions jsonb, candidate_fingerprint text,
 candidate_epoch bigint, candidate_control_revision bigint, candidate_checksum text,
 cursor_time text, cursor_id text, copied bigint NOT NULL DEFAULT 0,
 chunk integer NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0, retry_at timestamptz, error_code text,
 PRIMARY KEY(website_id,bucket),
 CHECK(bucket=date_bin(interval '1 hour',bucket,timestamptz '2000-01-01Z'))
);
CREATE INDEX liekan_analytics_engine_work ON liekan_analytics_engine_unit(retry_at,bucket);
CREATE INDEX liekan_engine_pending_unit ON liekan_analytics_engine_unit(bucket,website_id) WHERE generation IS NULL OR candidate IS NOT NULL OR verified_at IS NULL;
CREATE TABLE liekan_analytics_engine_generation (
 id uuid PRIMARY KEY, website_id uuid NOT NULL, retired_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX liekan_analytics_engine_retired ON liekan_analytics_engine_generation(retired_at);
CREATE TABLE liekan_analytics_engine_operation (
 request_id uuid PRIMARY KEY, actor_id uuid NOT NULL, request_hash text NOT NULL,
 action text NOT NULL, locale text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION liekan_engine_fingerprint(site uuid,starts timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT md5(coalesce(string_agg(extract(epoch FROM d.bucket)::text||':'||d.shard::text||':'||d.revision::text,',' ORDER BY d.bucket,d.shard),''))
 FROM liekan_analytics_engine_dirty d WHERE d.website_id=site
  AND d.bucket>=starts AND d.bucket<starts+interval '1 hour'
$$;

CREATE FUNCTION liekan_engine_log_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rows_sql text; item record;
BEGIN
 IF NOT (SELECT capture FROM liekan_analytics_engine WHERE id=1) THEN RETURN NULL; END IF;
 rows_sql:=CASE TG_OP WHEN 'INSERT' THEN 'SELECT * FROM new_rows' WHEN 'DELETE' THEN 'SELECT * FROM old_rows' ELSE 'SELECT * FROM old_rows UNION ALL SELECT * FROM new_rows' END;
 EXECUTE format('INSERT INTO liekan_analytics_engine_site(website_id,history_cursor)
 SELECT r.website_id,date_bin(interval ''1 hour'',min(r.created_at),timestamptz ''2000-01-01Z'') FROM (%s) r
 JOIN website w ON w.website_id=r.website_id AND w.deleted_at IS NULL
 WHERE NOT EXISTS(SELECT 1 FROM liekan_analytics_engine_site s WHERE s.website_id=r.website_id) GROUP BY r.website_id
 ON CONFLICT(website_id) DO NOTHING',rows_sql);
 EXECUTE format('UPDATE liekan_analytics_engine_site s SET history_cursor=least(s.history_cursor,x.starts),history_start=x.starts
 FROM (SELECT website_id,date_bin(interval ''1 hour'',min(created_at),timestamptz ''2000-01-01Z'') AS starts FROM (%s) r GROUP BY website_id) x
 WHERE s.website_id=x.website_id AND (s.history_start IS NULL OR x.starts<s.history_start)',rows_sql);
 FOR item IN EXECUTE format('SELECT DISTINCT r.website_id,date_bin(interval ''1 hour'',r.created_at,timestamptz ''2000-01-01Z'') AS bucket FROM (%s) r ORDER BY 1,2',rows_sql) LOOP
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(item.website_id::text||extract(epoch FROM item.bucket)::bigint::text,57001));
 END LOOP;
 EXECUTE format('INSERT INTO liekan_analytics_engine_dirty(website_id,bucket,shard)
 SELECT DISTINCT r.website_id,date_bin(interval ''5 minutes'',r.created_at,timestamptz ''2000-01-01Z''),
 (get_byte(decode(md5(r.id),''hex''),0) %% 32)::smallint FROM (%s) r
 JOIN liekan_analytics_engine_site s USING(website_id)
 ORDER BY 1,2,3 ON CONFLICT(website_id,bucket,shard) DO UPDATE
 SET revision=liekan_analytics_engine_dirty.revision+1,pending=true',rows_sql);
 RETURN NULL;
END $$;
CREATE TRIGGER liekan_engine_log_insert AFTER INSERT ON liekan_log REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION liekan_engine_log_capture();
CREATE TRIGGER liekan_engine_log_update AFTER UPDATE ON liekan_log REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION liekan_engine_log_capture();
CREATE TRIGGER liekan_engine_log_delete AFTER DELETE ON liekan_log REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION liekan_engine_log_capture();

CREATE FUNCTION liekan_engine_secondary_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rows_sql text; item record;
BEGIN
 IF NOT (SELECT capture FROM liekan_analytics_engine WHERE id=1) THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='liekan_crawler_evidence' THEN
  rows_sql:=CASE TG_OP WHEN 'INSERT' THEN 'SELECT website_id,log_id FROM new_rows' WHEN 'DELETE' THEN 'SELECT website_id,log_id FROM old_rows' ELSE 'SELECT website_id,log_id FROM old_rows UNION SELECT website_id,log_id FROM new_rows' END;
  FOR item IN EXECUTE format('SELECT DISTINCT l.website_id,date_bin(interval ''1 hour'',l.created_at,timestamptz ''2000-01-01Z'') AS bucket FROM (%s) r JOIN liekan_log l ON l.website_id=r.website_id AND l.id=r.log_id ORDER BY 1,2',rows_sql) LOOP
   PERFORM pg_advisory_xact_lock_shared(hashtextextended(item.website_id::text||extract(epoch FROM item.bucket)::bigint::text,57001));
  END LOOP;
  EXECUTE format('INSERT INTO liekan_analytics_engine_dirty(website_id,bucket,shard)
   SELECT DISTINCT l.website_id,date_bin(interval ''5 minutes'',l.created_at,timestamptz ''2000-01-01Z''),
   (get_byte(decode(md5(l.id),''hex''),0) %% 32)::smallint FROM (%s) r
   JOIN liekan_log l ON l.website_id=r.website_id AND l.id=r.log_id JOIN liekan_analytics_engine_site s ON s.website_id=l.website_id
   ORDER BY 1,2,3 ON CONFLICT(website_id,bucket,shard) DO UPDATE SET revision=liekan_analytics_engine_dirty.revision+1,pending=true',rows_sql);
  RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='liekan_history_repair_result' THEN
  rows_sql:=CASE TG_OP WHEN 'INSERT' THEN 'SELECT website_id,generation FROM new_rows' WHEN 'DELETE' THEN 'SELECT website_id,generation FROM old_rows' ELSE 'SELECT website_id,generation FROM old_rows UNION SELECT website_id,generation FROM new_rows' END;
  EXECUTE format('UPDATE liekan_analytics_engine_site s SET revision=revision+1 WHERE EXISTS(SELECT 1 FROM (%s) r JOIN liekan_history_repair_run run ON run.website_id=r.website_id AND run.active_generation=r.generation WHERE r.website_id=s.website_id)',rows_sql);
  RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='liekan_history_repair_run' AND TG_OP='UPDATE' THEN
  UPDATE liekan_analytics_engine_site s SET revision=revision+1 FROM new_rows n JOIN old_rows o USING(id)
   WHERE s.website_id=n.website_id AND (n.active_generation,n.active_revision) IS DISTINCT FROM (o.active_generation,o.active_revision);
  RETURN NULL;
 END IF;
 rows_sql:=CASE TG_OP WHEN 'INSERT' THEN 'SELECT website_id FROM new_rows' WHEN 'DELETE' THEN 'SELECT website_id FROM old_rows' ELSE 'SELECT website_id FROM old_rows UNION SELECT website_id FROM new_rows' END;
 EXECUTE format('UPDATE liekan_analytics_engine_site SET revision=revision+1 WHERE website_id IN (%s)',rows_sql);
 RETURN NULL;
END $$;
DO $$ DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['liekan_log_interval','liekan_crawler_evidence','liekan_history_repair_run','liekan_history_repair_result'] LOOP
  EXECUTE format('CREATE TRIGGER engine_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION liekan_engine_secondary_capture()',tab);
  EXECUTE format('CREATE TRIGGER engine_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION liekan_engine_secondary_capture()',tab);
  EXECUTE format('CREATE TRIGGER engine_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION liekan_engine_secondary_capture()',tab);
 END LOOP;
END $$;

CREATE FUNCTION liekan_engine_website_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE destination text;
BEGIN
 IF TG_OP='DELETE' OR (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NOT NULL)
  OR NEW.reset_at IS DISTINCT FROM OLD.reset_at THEN
  SELECT connection_hash INTO destination FROM liekan_analytics_engine WHERE id=1;
  INSERT INTO liekan_analytics_engine_site(website_id) VALUES(OLD.website_id) ON CONFLICT DO NOTHING;
  UPDATE liekan_analytics_engine_site SET epoch=epoch+1,revision=revision+1,purge_through=epoch+1,
   pending_targets=ARRAY(SELECT DISTINCT x FROM unnest(pending_targets||targets||ARRAY[destination]) x WHERE x IS NOT NULL),
   sweep_targets=ARRAY(SELECT DISTINCT x FROM unnest(sweep_targets||targets||ARRAY[destination]) x WHERE x IS NOT NULL),
   purge_pending=(destination IS NOT NULL OR cardinality(targets)>0 OR cardinality(pending_targets)>0),purge_checked_at=NULL
   WHERE website_id=OLD.website_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER liekan_engine_website_update AFTER UPDATE ON website FOR EACH ROW EXECUTE FUNCTION liekan_engine_website_capture();
CREATE TRIGGER liekan_engine_website_delete AFTER DELETE ON website FOR EACH ROW EXECUTE FUNCTION liekan_engine_website_capture();

CREATE FUNCTION liekan_engine_truncate_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE destination text;
BEGIN
 SELECT connection_hash INTO destination FROM liekan_analytics_engine WHERE id=1;
 UPDATE liekan_analytics_engine_site SET revision=revision+1,epoch=epoch+1,purge_through=epoch+1,purge_checked_at=NULL,
  pending_targets=ARRAY(SELECT DISTINCT x FROM unnest(pending_targets||targets||ARRAY[destination]) x WHERE x IS NOT NULL),
  sweep_targets=ARRAY(SELECT DISTINCT x FROM unnest(sweep_targets||targets||ARRAY[destination]) x WHERE x IS NOT NULL),
  purge_pending=(destination IS NOT NULL OR cardinality(targets)>0 OR cardinality(pending_targets)>0);
 RETURN NULL;
END $$;
DO $$ DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['liekan_log','liekan_log_interval','liekan_crawler_evidence','liekan_history_repair_run','liekan_history_repair_result'] LOOP
  EXECUTE format('CREATE TRIGGER engine_truncate AFTER TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION liekan_engine_truncate_capture()',tab);
 END LOOP;
END $$;

-- Bind functions to the installation schema, including independent collector connections.
DO $$ DECLARE fn text;
BEGIN
 FOREACH fn IN ARRAY ARRAY['liekan_engine_fingerprint(uuid,timestamptz)','liekan_engine_log_capture()','liekan_engine_secondary_capture()','liekan_engine_website_capture()','liekan_engine_truncate_capture()'] LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path TO %I',fn,current_schema());
 END LOOP;
END $$;
