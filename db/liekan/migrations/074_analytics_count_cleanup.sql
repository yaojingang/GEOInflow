-- A worker must acknowledge each statistics family before completing a destination purge.
ALTER TABLE liekan_analytics_engine_site
 ADD COLUMN counts_pending_targets text[] NOT NULL DEFAULT '{}',
 ADD COLUMN counts_swept_at timestamptz;
UPDATE liekan_analytics_engine_site SET counts_pending_targets=ARRAY(
 SELECT DISTINCT x FROM unnest(pending_targets||sweep_targets) x WHERE x IS NOT NULL
) WHERE purge_pending;
UPDATE liekan_analytics_engine_site SET pending_targets=ARRAY(
 SELECT DISTINCT x FROM unnest(pending_targets||counts_pending_targets) x WHERE x IS NOT NULL
),purge_pending=true WHERE cardinality(counts_pending_targets)>0;

CREATE FUNCTION liekan_engine_count_cleanup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.purge_through>OLD.purge_through THEN
  NEW.counts_pending_targets:=ARRAY(SELECT DISTINCT x FROM unnest(
   OLD.counts_pending_targets||NEW.pending_targets||NEW.sweep_targets) x WHERE x IS NOT NULL);
  NEW.counts_swept_at:=NULL;
 END IF;
 IF (NOT NEW.purge_pending AND cardinality(NEW.counts_pending_targets)>0)
  OR EXISTS(SELECT 1 FROM unnest(OLD.counts_pending_targets) x
   WHERE x=ANY(NEW.counts_pending_targets) AND NOT x=ANY(NEW.pending_targets)) THEN
  RAISE EXCEPTION 'engine-count-cleanup-required';
 END IF;
 NEW.pending_targets:=ARRAY(SELECT DISTINCT x FROM unnest(NEW.pending_targets||NEW.counts_pending_targets) x WHERE x IS NOT NULL);
 NEW.purge_pending:=cardinality(NEW.pending_targets)>0;
 RETURN NEW;
END $$;
CREATE TRIGGER liekan_engine_count_cleanup_guard BEFORE UPDATE ON liekan_analytics_engine_site
 FOR EACH ROW EXECUTE FUNCTION liekan_engine_count_cleanup_guard();
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION liekan_engine_count_cleanup_guard() SET search_path TO %I',current_schema());
END $$;
