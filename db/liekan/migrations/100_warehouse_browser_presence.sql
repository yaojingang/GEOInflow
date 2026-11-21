-- Raw browser collection is independent of report ranges and traffic quality.
CREATE TABLE liekan_warehouse_browser_presence (
  website_id uuid PRIMARY KEY REFERENCES website(website_id) ON DELETE CASCADE,
  epoch bigint NOT NULL,
  deletion_revision bigint NOT NULL,
  publication bigint NOT NULL,
  verified_through bigint NOT NULL,
  pending_publications bigint NOT NULL,
  verified boolean NOT NULL,
  first_page_at timestamptz,
  last_event_at timestamptz
);
