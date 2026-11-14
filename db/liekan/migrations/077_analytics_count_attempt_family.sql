-- Retry budgets belong to the producer family that acquired the work.
ALTER TABLE liekan_analytics_engine_unit ADD COLUMN counts_attempt_version text;

CREATE FUNCTION liekan_engine_count_attempt_family() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.lease_token IS NOT NULL AND NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
  -- Older workers acquire a lease without subsequently identifying their count family.
  NEW.counts_attempt_version:=NULL;
 ELSIF NEW.counts_verified_at IS NOT NULL AND NEW.counts_verified_at IS DISTINCT FROM OLD.counts_verified_at THEN
  NEW.counts_attempt_version:=NEW.counts_version;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER liekan_engine_count_attempt_family BEFORE UPDATE ON liekan_analytics_engine_unit
 FOR EACH ROW EXECUTE FUNCTION liekan_engine_count_attempt_family();
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION liekan_engine_count_attempt_family() SET search_path TO %I',current_schema());
END $$;
