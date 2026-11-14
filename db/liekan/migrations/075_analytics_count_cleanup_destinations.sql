-- Completed historical destinations remain sweep-only across subsequent source epochs.
CREATE OR REPLACE FUNCTION liekan_engine_count_cleanup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.purge_through>OLD.purge_through THEN
  NEW.counts_pending_targets:=ARRAY(SELECT DISTINCT x FROM unnest(
   OLD.counts_pending_targets||NEW.pending_targets) x WHERE x IS NOT NULL);
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
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION liekan_engine_count_cleanup_guard() SET search_path TO %I',current_schema());
END $$;
