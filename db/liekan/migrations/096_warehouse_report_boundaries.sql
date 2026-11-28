-- Opaque, short-lived log pagination handles. No visitor content is retained.
CREATE TABLE liekan_warehouse_report_boundary (
  token character(64) PRIMARY KEY,
  website_id uuid NOT NULL REFERENCES website(website_id) ON DELETE CASCADE,
  scope character(64) NOT NULL,
  control character(64) NOT NULL,
  epoch bigint NOT NULL,
  publication bigint NOT NULL,
  deletion_revision bigint NOT NULL,
  reference_id uuid NOT NULL REFERENCES liekan_warehouse_reference(reference_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX liekan_warehouse_report_boundary_expiry ON liekan_warehouse_report_boundary(expires_at);
