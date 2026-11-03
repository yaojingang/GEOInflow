ALTER TABLE liekan_warehouse_site ADD COLUMN bookmark_revision bigint NOT NULL DEFAULT 0 CHECK(bookmark_revision>=0);
CREATE FUNCTION liekan_warehouse_bookmark_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE liekan_warehouse_site SET bookmark_revision=bookmark_revision+1 WHERE website_id=OLD.website_id;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.website_id IS DISTINCT FROM OLD.website_id) THEN
    UPDATE liekan_warehouse_site SET bookmark_revision=bookmark_revision+1 WHERE website_id=NEW.website_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER liekan_warehouse_bookmark_changed AFTER INSERT OR UPDATE OR DELETE ON session_replay_saved
  FOR EACH ROW EXECUTE FUNCTION liekan_warehouse_bookmark_changed();
