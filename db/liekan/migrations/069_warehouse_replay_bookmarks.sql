-- Ownership for a user-created bookmark is business metadata, not a copy of
-- session/replay analytics. Legacy bookmarks may reference multiple sessions.
CREATE TABLE liekan_warehouse_replay_bookmark_owner (
  saved_replay_id uuid NOT NULL REFERENCES session_replay_saved(saved_replay_id) ON DELETE CASCADE,
  website_id uuid NOT NULL,
  session_id uuid NOT NULL,
  PRIMARY KEY(saved_replay_id,session_id)
);
CREATE INDEX liekan_warehouse_replay_bookmark_session ON liekan_warehouse_replay_bookmark_owner(website_id,session_id);
