-- Share bounded foreground computation across application and worker instances.
SET LOCAL lock_timeout = '2s';
CREATE TABLE liekan_analysis_read_lease (
 slot smallint PRIMARY KEY CHECK(slot BETWEEN 1 AND 2),
 token uuid, epoch bigint NOT NULL DEFAULT 0, lease_until timestamptz
);
INSERT INTO liekan_analysis_read_lease(slot) VALUES(1),(2);
ALTER TABLE liekan_analysis_query ADD COLUMN fast_attempted_at timestamptz;
ALTER TABLE liekan_analysis_query_consumer ADD COLUMN managed boolean NOT NULL DEFAULT false;
CREATE TABLE liekan_analysis_query_viewer (
 job_id uuid NOT NULL, actor_id uuid NOT NULL, viewer_id uuid NOT NULL,
 lease_until timestamptz NOT NULL,
 PRIMARY KEY(job_id,actor_id,viewer_id),
 FOREIGN KEY(job_id,actor_id) REFERENCES liekan_analysis_query_consumer(job_id,actor_id) ON DELETE CASCADE
);
CREATE INDEX liekan_analysis_viewer_demand ON liekan_analysis_query_viewer(job_id,lease_until);
