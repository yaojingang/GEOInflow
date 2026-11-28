-- Warehouse v2 does not populate the legacy v1 liekan_warehouse_site table.
-- Rebind liekan_warehouse_upload.website_id to reference website(website_id)
-- directly so manual and automatic log uploads preserve referential integrity
-- without requiring legacy v1 site registration rows.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    JOIN pg_class frel ON frel.oid = c.confrelid
    WHERE ns.nspname = current_schema()
      AND rel.relname = 'liekan_warehouse_upload'
      AND c.contype = 'f'
      AND frel.relname = 'liekan_warehouse_site'
  LOOP
    EXECUTE format('ALTER TABLE liekan_warehouse_upload DROP CONSTRAINT %I', rec.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    JOIN pg_class frel ON frel.oid = c.confrelid
    WHERE ns.nspname = current_schema()
      AND rel.relname = 'liekan_warehouse_upload'
      AND c.contype = 'f'
      AND frel.relname = 'website'
  ) THEN
    ALTER TABLE liekan_warehouse_upload
      ADD CONSTRAINT liekan_warehouse_upload_website_id_website_fkey
      FOREIGN KEY (website_id) REFERENCES website(website_id) ON DELETE CASCADE;
  END IF;
END $$;
