-- New warehouse coverage is data. Corrections to existing proof retain the
-- original control fence. The existing deletion, source and rule triggers remain active.
CREATE FUNCTION liekan_geo_record_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  site uuid := NEW.website_id;
  starts timestamptz := NEW.starts_at;
  ends timestamptz := NEW.ends_at;
  fence_correction boolean := false;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM liekan_warehouse_installation WHERE id=1 AND authority='clickhouse') THEN
      RETURN NEW;
    END IF;
  ELSE
    IF (to_jsonb(OLD)-'recorded_at') = (to_jsonb(NEW)-'recorded_at') THEN RETURN NEW; END IF;
    IF (OLD.website_id,OLD.source_id,OLD.starts_at,OLD.state) =
       (NEW.website_id,NEW.source_id,NEW.starts_at,NEW.state) AND NEW.ends_at>=OLD.ends_at
       AND (OLD.evidence=NEW.evidence OR (NEW.state='complete' AND
         (OLD.evidence-'cursors'-'fromBatchId'-'toBatchId')=(NEW.evidence-'cursors'-'fromBatchId'-'toBatchId'))) THEN
      IF EXISTS (SELECT 1 FROM liekan_warehouse_installation WHERE id=1 AND authority='clickhouse') THEN
        IF NEW.ends_at=OLD.ends_at THEN RETURN NEW; END IF;
        starts := OLD.ends_at;
      ELSIF NEW.state='complete' THEN
        RETURN NEW;
      ELSE
        fence_correction := true;
        ends := OLD.ends_at;
      END IF;
    ELSE
      site := OLD.website_id;
      starts := OLD.starts_at;
      ends := OLD.ends_at;
      fence_correction := true;
    END IF;
  END IF;

  INSERT INTO liekan_geo_weight_evidence_revision(website_id,starts_at,ends_at)
  SELECT site,starts,ends
  WHERE EXISTS (SELECT 1 FROM liekan_geo_weight_snapshot s
    WHERE s.website_id=site AND s.expires_at>now()
      AND to_timestamp((s.input_boundary->'window'->>'startAt')::double precision/1000)<ends
      AND to_timestamp((s.input_boundary->'window'->>'endAt')::double precision/1000)>starts)
    OR EXISTS (SELECT 1 FROM liekan_geo_weight_head h
    WHERE h.website_id=site AND h.task_status IN ('queued','running')
      AND ((h.as_of-59)::timestamp AT TIME ZONE h.timezone)<ends
      AND ((h.as_of+1)::timestamp AT TIME ZONE h.timezone)>starts)
  ON CONFLICT(website_id,starts_at,ends_at) DO UPDATE
    SET revision=nextval('liekan_geo_weight_evidence_revision_revision_seq'),created_at=now();
  IF FOUND AND fence_correction THEN
    UPDATE liekan_log_state SET policy_revision=policy_revision+1 WHERE website_id=site;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER liekan_warehouse_geo_coverage_added ON liekan_crawler_quality;
DROP FUNCTION liekan_warehouse_geo_coverage_added();
DROP TRIGGER liekan_geo_quality_correction ON liekan_crawler_quality;
CREATE TRIGGER liekan_geo_quality_correction AFTER DELETE ON liekan_crawler_quality
  FOR EACH ROW EXECUTE FUNCTION liekan_geo_invalidate_proof();
CREATE TRIGGER liekan_geo_quality_observed AFTER INSERT OR UPDATE ON liekan_crawler_quality
  FOR EACH ROW EXECUTE FUNCTION liekan_geo_record_coverage();
