-- Upstream tracker IDs include links and pixels. Keep resource authority in PG
-- without pretending that these resources are rows in the website table.
ALTER TABLE liekan_warehouse_site DROP CONSTRAINT liekan_warehouse_site_website_id_fkey;
ALTER TABLE liekan_warehouse_site ADD COLUMN resource_type text NOT NULL DEFAULT 'website'
  CHECK(resource_type IN ('website','link','pixel'));
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['attempt','work','candidate','deletion','reference'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I','liekan_warehouse_'||name,'liekan_warehouse_'||name||'_website_id_fkey');
    EXECUTE format('ALTER TABLE %I ADD FOREIGN KEY(website_id) REFERENCES liekan_warehouse_site(website_id) ON DELETE CASCADE','liekan_warehouse_'||name);
  END LOOP;
END $$;

CREATE FUNCTION liekan_warehouse_collection_policy_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE liekan_warehouse_site SET policy_revision=NEW.revision,updated_at=clock_timestamp()
    WHERE website_id=NEW.website_id;
  RETURN NEW;
END $$;
CREATE TRIGGER liekan_warehouse_collection_policy_changed
  AFTER INSERT OR UPDATE OF revision ON liekan_collection_policy
  FOR EACH ROW EXECUTE FUNCTION liekan_warehouse_collection_policy_changed();
