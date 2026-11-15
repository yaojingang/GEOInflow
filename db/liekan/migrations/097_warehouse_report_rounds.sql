-- A recoverable per-site report round. The reference protects its accepted
-- source boundary and model builds between individual page computations.
CREATE TABLE liekan_warehouse_report_round (
  website_id uuid PRIMARY KEY REFERENCES website(website_id) ON DELETE CASCADE,
  id uuid NOT NULL UNIQUE,
  control_version text NOT NULL,
  model_version text NOT NULL,
  catalog_version uuid NOT NULL,
  format_version integer NOT NULL,
  epoch bigint NOT NULL,
  publication bigint NOT NULL,
  deletion_revision bigint NOT NULL,
  cutoff_at timestamptz NOT NULL,
  reference_id uuid NOT NULL REFERENCES liekan_warehouse_reference(reference_id) ON DELETE CASCADE,
  members uuid[] NOT NULL,
  pending uuid[] NOT NULL,
  prepared jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
