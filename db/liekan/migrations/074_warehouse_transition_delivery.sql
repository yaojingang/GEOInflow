-- Payload stays in the immutable temporary result journal. This table holds
-- only durable broker positions, checksums and fencing metadata.
CREATE TABLE liekan_warehouse_transition_delivery (
  sequence bigint PRIMARY KEY REFERENCES liekan_warehouse_transition_result(sequence),
  operation_id uuid NOT NULL UNIQUE,
  digest character(64) NOT NULL,
  topic_id text NOT NULL,
  offsets jsonb NOT NULL CHECK(jsonb_typeof(offsets)='array'),
  chunks integer NOT NULL CHECK(chunks BETWEEN 1 AND 1024),
  created_at timestamptz NOT NULL DEFAULT now()
);
