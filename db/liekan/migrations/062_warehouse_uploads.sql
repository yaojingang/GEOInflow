-- Bounded status for each upload; normalized log payloads live only in the queue
-- and CH. Counts are advanced exactly once with the publication operation.
CREATE TABLE liekan_warehouse_upload (
  batch_id uuid PRIMARY KEY,
  website_id uuid NOT NULL REFERENCES liekan_warehouse_site(website_id) ON DELETE CASCADE,
  source_id uuid,
  source_epoch integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('automatic','manual')),
  digest character(64) NOT NULL,
  expected integer NOT NULL CHECK(expected>=0),
  processed integer NOT NULL DEFAULT 0 CHECK(processed>=0),
  inserted integer NOT NULL DEFAULT 0 CHECK(inserted>=0),
  duplicates integer NOT NULL DEFAULT 0 CHECK(duplicates>=0),
  conflicts integer NOT NULL DEFAULT 0 CHECK(conflicts>=0),
  queued boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processed','failed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(processed<=expected)
);
ALTER TABLE liekan_warehouse_attempt ADD COLUMN effects jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(effects)='array');
CREATE INDEX liekan_warehouse_work_input ON liekan_warehouse_work(input_id) WHERE status<>'cancelled';
