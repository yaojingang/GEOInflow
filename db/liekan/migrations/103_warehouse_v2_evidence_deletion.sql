CREATE TABLE liekan_v2_evidence_deletion (
  website_id uuid PRIMARY KEY REFERENCES website(website_id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  pending_kind text CHECK (pending_kind IN ('reset', 'session')),
  session_id uuid,
  epoch bigint NOT NULL CHECK (epoch > 0),
  touched_hours text[],
  CHECK ((pending_kind IS NOT DISTINCT FROM 'session') = (session_id IS NOT NULL)),
  CHECK (touched_hours IS NULL OR session_id IS NOT NULL)
);
