-- GEO results are retained business proof. A fixed serialized-size allowance
-- must not suppress a valid computation; physical capacity is monitored instead.
ALTER TABLE liekan_geo_weight_snapshot DROP CONSTRAINT liekan_geo_weight_snapshot_result_bytes_check;
ALTER TABLE liekan_geo_weight_snapshot ADD CONSTRAINT liekan_geo_weight_snapshot_result_bytes_check CHECK(result_bytes>0);

-- New coverage evidence can change an observed historical score. Legacy PG
-- behavior is retained until this installation has CH authority.
CREATE FUNCTION liekan_warehouse_geo_coverage_added() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM liekan_warehouse_installation WHERE id=1 AND authority='clickhouse')
    AND (EXISTS(SELECT 1 FROM liekan_geo_weight_snapshot s WHERE s.website_id=NEW.website_id AND s.expires_at>now()
      AND to_timestamp((s.input_boundary->'window'->>'startAt')::double precision/1000)<NEW.ends_at
      AND to_timestamp((s.input_boundary->'window'->>'endAt')::double precision/1000)>NEW.starts_at)
    OR EXISTS(SELECT 1 FROM liekan_geo_weight_head h WHERE h.website_id=NEW.website_id AND h.task_status IN('queued','running')
      AND ((h.as_of-59)::timestamp AT TIME ZONE h.timezone)<NEW.ends_at AND ((h.as_of+1)::timestamp AT TIME ZONE h.timezone)>NEW.starts_at)) THEN
    INSERT INTO liekan_geo_weight_evidence_revision(website_id,starts_at,ends_at) VALUES(NEW.website_id,NEW.starts_at,NEW.ends_at)
      ON CONFLICT(website_id,starts_at,ends_at) DO UPDATE SET revision=nextval('liekan_geo_weight_evidence_revision_revision_seq'),created_at=now();
    UPDATE liekan_log_state SET policy_revision=policy_revision+1 WHERE website_id=NEW.website_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER liekan_warehouse_geo_coverage_added AFTER INSERT ON liekan_crawler_quality
  FOR EACH ROW EXECUTE FUNCTION liekan_warehouse_geo_coverage_added();
