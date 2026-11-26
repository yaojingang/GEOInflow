ALTER TABLE liekan_warehouse_site ADD COLUMN catalog_revision bigint NOT NULL DEFAULT 0 CHECK(catalog_revision>=0);
CREATE INDEX liekan_warehouse_catalog_scan ON liekan_catalog(website_id,path COLLATE "C");

CREATE FUNCTION liekan_warehouse_catalog_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    UPDATE liekan_warehouse_site SET catalog_revision=catalog_revision+1 WHERE website_id IN(SELECT website_id FROM new_catalog);
  ELSIF TG_OP='DELETE' THEN
    UPDATE liekan_warehouse_site SET catalog_revision=catalog_revision+1 WHERE website_id IN(SELECT website_id FROM old_catalog);
  ELSE
    UPDATE liekan_warehouse_site SET catalog_revision=catalog_revision+1 WHERE website_id IN(SELECT website_id FROM new_catalog UNION SELECT website_id FROM old_catalog);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER liekan_warehouse_catalog_insert AFTER INSERT ON liekan_catalog REFERENCING NEW TABLE AS new_catalog
  FOR EACH STATEMENT EXECUTE FUNCTION liekan_warehouse_catalog_changed();
CREATE TRIGGER liekan_warehouse_catalog_update AFTER UPDATE ON liekan_catalog REFERENCING NEW TABLE AS new_catalog OLD TABLE AS old_catalog
  FOR EACH STATEMENT EXECUTE FUNCTION liekan_warehouse_catalog_changed();
CREATE TRIGGER liekan_warehouse_catalog_delete AFTER DELETE ON liekan_catalog REFERENCING OLD TABLE AS old_catalog
  FOR EACH STATEMENT EXECUTE FUNCTION liekan_warehouse_catalog_changed();
