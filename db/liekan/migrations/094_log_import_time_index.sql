CREATE INDEX CONCURRENTLY liekan_import_website_imported_at_idx
  ON liekan_import (website_id, imported_at);
