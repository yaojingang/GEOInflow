-- A retired identifier must never inherit the old tombstones or publications.
CREATE OR REPLACE FUNCTION liekan_warehouse_resource_created() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM liekan_warehouse_installation WHERE id=1 AND (authority='clickhouse' OR(facts_fenced AND authority='postgres'))) THEN RETURN NEW; END IF;
  resource=(to_jsonb(NEW)->>(TG_TABLE_NAME||'_id'))::uuid;
  INSERT INTO liekan_warehouse_site(website_id,resource_type,policy_revision)
    VALUES(resource,TG_TABLE_NAME,coalesce((SELECT revision FROM liekan_collection_policy WHERE website_id=resource),0));
  RETURN NEW;
END $$;
