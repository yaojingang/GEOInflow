CREATE TABLE liekan_warehouse_overview_snapshot (
  id uuid PRIMARY KEY,
  website_id uuid NOT NULL REFERENCES website(website_id) ON DELETE CASCADE,
  query_key text NOT NULL,
  parameters jsonb NOT NULL,
  catalog_version uuid NOT NULL,
  format_version integer NOT NULL,
  preset boolean NOT NULL,
  control_version text NOT NULL,
  publication bigint,
  result jsonb,
  generated_at timestamptz,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  error_code text,
  last_requested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (website_id, query_key)
);
CREATE INDEX liekan_warehouse_overview_due
  ON liekan_warehouse_overview_snapshot (format_version, next_attempt_at, id);
CREATE INDEX liekan_warehouse_overview_lease
  ON liekan_warehouse_overview_snapshot (lease_until) WHERE lease_until IS NOT NULL;
CREATE INDEX liekan_warehouse_overview_retention
  ON liekan_warehouse_overview_snapshot (last_requested_at, id);
