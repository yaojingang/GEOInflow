-- Publications belong to all tracker resource types, including links and pixels.
-- Match the resource authority used by attempts, candidates and read references.
ALTER TABLE liekan_warehouse_publication
  DROP CONSTRAINT liekan_warehouse_publication_website_id_fkey;
ALTER TABLE liekan_warehouse_publication
  ADD CONSTRAINT liekan_warehouse_publication_website_id_fkey
  FOREIGN KEY (website_id) REFERENCES liekan_warehouse_site(website_id) ON DELETE CASCADE;
