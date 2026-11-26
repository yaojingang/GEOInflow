-- Register empty resources and fence cascaded account/team deletion. This is
-- business control only; it never copies analytics facts into PostgreSQL.
CREATE FUNCTION liekan_warehouse_resource_created() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM liekan_warehouse_installation WHERE id=1 AND authority='clickhouse') THEN RETURN NEW; END IF;
  resource=(to_jsonb(NEW)->>(TG_TABLE_NAME||'_id'))::uuid;
  INSERT INTO liekan_warehouse_site(website_id,resource_type,policy_revision)
    VALUES(resource,TG_TABLE_NAME,coalesce((SELECT revision FROM liekan_collection_policy WHERE website_id=resource),0));
  RETURN NEW;
END $$;

CREATE FUNCTION liekan_warehouse_resource_removed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource uuid; current_site liekan_warehouse_site%ROWTYPE; pending liekan_warehouse_deletion%ROWTYPE; topic text;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL) THEN RETURN NEW; END IF;
  SELECT topic_id INTO topic FROM liekan_warehouse_installation WHERE id=1 AND authority='clickhouse' FOR SHARE;
  IF NOT FOUND THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  resource=(to_jsonb(OLD)->>(TG_TABLE_NAME||'_id'))::uuid;
  INSERT INTO liekan_warehouse_site(website_id,resource_type) VALUES(resource,TG_TABLE_NAME) ON CONFLICT DO NOTHING;
  SELECT * INTO current_site FROM liekan_warehouse_site WHERE website_id=resource FOR UPDATE;
  IF current_site.state='active' THEN
    IF EXISTS(SELECT 1 FROM liekan_warehouse_attempt WHERE website_id=resource AND status='confirmed') THEN
      RAISE EXCEPTION 'warehouse-deletion-awaiting-publication' USING ERRCODE='55P03';
    END IF;
    SELECT * INTO pending FROM liekan_warehouse_deletion WHERE website_id=resource AND status NOT IN('active','reclaimed');
    IF FOUND THEN
      IF pending.kind<>'website' THEN RAISE EXCEPTION 'warehouse-lifecycle-pending' USING ERRCODE='55P03'; END IF;
    ELSE
      UPDATE liekan_warehouse_site SET version=version+1,updated_at=clock_timestamp() WHERE website_id=resource;
      INSERT INTO liekan_warehouse_deletion(operation_id,website_id,kind,epoch,revision,version,topic_id,status)
        VALUES(gen_random_uuid(),resource,'website',current_site.epoch,current_site.deletion_revision+1,current_site.version+1,topic,'pending');
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

DO $$
DECLARE resource text;
BEGIN
  FOREACH resource IN ARRAY ARRAY['website','link','pixel'] LOOP
    EXECUTE format('CREATE TRIGGER liekan_warehouse_resource_created AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION liekan_warehouse_resource_created()',resource);
    EXECUTE format('CREATE TRIGGER liekan_warehouse_resource_removed BEFORE DELETE OR UPDATE OF deleted_at ON %I FOR EACH ROW EXECUTE FUNCTION liekan_warehouse_resource_removed()',resource);
  END LOOP;
END $$;
