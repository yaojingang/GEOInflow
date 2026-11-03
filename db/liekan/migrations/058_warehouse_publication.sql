-- A publication is reserved only after every selected family has been verified.
-- The chosen manifest stays immutable across retries and owner changes. An old
-- worker may append the same manifest but cannot advance a changed site epoch.
CREATE TABLE liekan_warehouse_publication (
  operation_id uuid PRIMARY KEY,
  website_id uuid NOT NULL REFERENCES website(website_id) ON DELETE CASCADE,
  epoch bigint NOT NULL,
  publication bigint NOT NULL CHECK (publication > 0),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'array'),
  manifest_digest character(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'published', 'obsolete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (website_id, epoch, publication)
);
CREATE UNIQUE INDEX liekan_warehouse_publication_pending
  ON liekan_warehouse_publication(website_id) WHERE status = 'reserved';
