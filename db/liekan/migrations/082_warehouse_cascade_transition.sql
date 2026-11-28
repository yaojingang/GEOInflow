-- Parent/account cascades must establish their durable deletion before legacy
-- FK cleanup removes receipts. The same transaction fences concurrent intake.
CREATE FUNCTION liekan_warehouse_prepare_removal(resource uuid, resource_kind text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE installation liekan_warehouse_installation%ROWTYPE;
        current_site liekan_warehouse_site%ROWTYPE;
        pending liekan_warehouse_deletion%ROWTYPE;
BEGIN
  IF resource_kind NOT IN('website','link','pixel') THEN RAISE EXCEPTION 'warehouse-invalid-resource'; END IF;
  SELECT * INTO installation FROM liekan_warehouse_installation WHERE id=1 FOR SHARE;
  IF NOT FOUND OR (NOT installation.facts_fenced AND installation.authority<>'clickhouse') THEN RETURN; END IF;
  IF installation.authority='frozen' THEN
    RAISE EXCEPTION 'warehouse-transition-barrier-active' USING ERRCODE='55P03';
  END IF;
  EXECUTE format('SELECT 1 FROM %I WHERE %I=$1 FOR UPDATE',resource_kind,resource_kind||'_id') USING resource;
  INSERT INTO liekan_warehouse_site(website_id,resource_type) VALUES(resource,resource_kind) ON CONFLICT DO NOTHING;
  SELECT * INTO current_site FROM liekan_warehouse_site WHERE website_id=resource FOR UPDATE;
  IF current_site.resource_type<>resource_kind THEN RAISE EXCEPTION 'warehouse-resource-conflict'; END IF;
  IF current_site.state='active' THEN
    IF EXISTS(SELECT 1 FROM liekan_warehouse_attempt WHERE website_id=resource AND status='confirmed'
       AND (installation.authority='clickhouse' OR NOT decision_projected)) THEN
      RAISE EXCEPTION 'warehouse-deletion-awaiting-publication' USING ERRCODE='55P03';
    END IF;
    SELECT * INTO pending FROM liekan_warehouse_deletion WHERE website_id=resource AND status NOT IN('active','reclaimed');
    IF FOUND THEN
      IF pending.kind<>'website' THEN RAISE EXCEPTION 'warehouse-lifecycle-pending' USING ERRCODE='55P03'; END IF;
    ELSE
      IF EXISTS(SELECT 1 FROM liekan_warehouse_barrier WHERE status IN('draining','frozen')) THEN
        RAISE EXCEPTION 'warehouse-transition-barrier-active' USING ERRCODE='55P03';
      END IF;
      UPDATE liekan_warehouse_site SET version=version+1,updated_at=clock_timestamp() WHERE website_id=resource;
      INSERT INTO liekan_warehouse_deletion(operation_id,website_id,kind,epoch,revision,version,topic_id,status,authority)
        VALUES(gen_random_uuid(),resource,'website',current_site.epoch,current_site.deletion_revision+1,current_site.version+1,installation.topic_id,'pending',installation.authority)
        RETURNING * INTO pending;
    END IF;
    INSERT INTO liekan_warehouse_pg_receipt_tombstone(operation_id,website_id,client_event_id,session_id)
      SELECT pending.operation_id,r.website_id,r.client_event_id,e.session_id FROM liekan_collection_receipt r
      LEFT JOIN website_event e ON e.event_id=r.event_id AND e.website_id=r.website_id
      WHERE r.website_id=resource ON CONFLICT DO NOTHING;
  END IF;
  PERFORM set_config('liekan.warehouse_writer','lifecycle',true);
END $$;

CREATE OR REPLACE FUNCTION liekan_warehouse_resource_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL) THEN RETURN NEW; END IF;
  PERFORM liekan_warehouse_prepare_removal((to_jsonb(OLD)->>(TG_TABLE_NAME||'_id'))::uuid,TG_TABLE_NAME);
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

CREATE OR REPLACE FUNCTION liekan_warehouse_resource_created() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM liekan_warehouse_installation WHERE id=1 AND (authority='clickhouse' OR(facts_fenced AND authority='postgres'))) THEN RETURN NEW; END IF;
  resource=(to_jsonb(NEW)->>(TG_TABLE_NAME||'_id'))::uuid;
  INSERT INTO liekan_warehouse_site(website_id,resource_type,policy_revision)
    VALUES(resource,TG_TABLE_NAME,coalesce((SELECT revision FROM liekan_collection_policy WHERE website_id=resource),0)) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
