-- Rebuildable private report modules share the existing statistics capacity budget.
CREATE TABLE liekan_report_fragment (
 website_id uuid NOT NULL REFERENCES website(website_id) ON DELETE CASCADE,
 query_key text NOT NULL,
 epoch bigint NOT NULL,
 namespace text NOT NULL,
 fingerprint text NOT NULL,
 dependency_end timestamptz NOT NULL,
 result bytea NOT NULL,
 result_bytes integer NOT NULL CHECK(result_bytes BETWEEN 0 AND 2097152),
 generated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(website_id,query_key)
);
CREATE INDEX liekan_report_fragment_recency ON liekan_report_fragment(website_id,last_read_at);
CREATE INDEX liekan_report_fragment_expiry ON liekan_report_fragment(last_read_at);
