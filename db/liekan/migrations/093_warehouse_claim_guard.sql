-- Claims share a lifecycle guard while confirmation and publication advance
-- their counters on the site row. Acquire the site key lock before the guard
-- to follow the order used by deletion and the attempt's foreign key.
CREATE TABLE liekan_warehouse_claim_guard (
  website_id uuid PRIMARY KEY REFERENCES liekan_warehouse_site(website_id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0
);

INSERT INTO liekan_warehouse_claim_guard(website_id)
  SELECT website_id FROM liekan_warehouse_site;

CREATE FUNCTION liekan_warehouse_create_claim_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO liekan_warehouse_claim_guard(website_id) VALUES(NEW.website_id);
  RETURN NEW;
END;
$$;

CREATE FUNCTION liekan_warehouse_advance_claim_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- Change the tuple so a repeatable-read claimant cannot use a snapshot
  -- taken before a concurrent lifecycle change or deletion request.
  UPDATE liekan_warehouse_claim_guard SET revision=revision+1 WHERE website_id=NEW.website_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse-claim-guard-missing' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER liekan_warehouse_claim_guard_created
  AFTER INSERT ON liekan_warehouse_site
  FOR EACH ROW EXECUTE FUNCTION liekan_warehouse_create_claim_guard();

CREATE TRIGGER liekan_warehouse_claim_guard_lifecycle
  BEFORE UPDATE OF state,epoch,deletion_revision,policy_revision ON liekan_warehouse_site
  FOR EACH ROW WHEN (
    (OLD.state,OLD.epoch,OLD.deletion_revision,OLD.policy_revision) IS DISTINCT FROM
    (NEW.state,NEW.epoch,NEW.deletion_revision,NEW.policy_revision)
  ) EXECUTE FUNCTION liekan_warehouse_advance_claim_guard();

-- A pending deletion fences claims before its published revision advances.
CREATE TRIGGER liekan_warehouse_claim_guard_deletion
  BEFORE INSERT ON liekan_warehouse_deletion
  FOR EACH ROW EXECUTE FUNCTION liekan_warehouse_advance_claim_guard();
