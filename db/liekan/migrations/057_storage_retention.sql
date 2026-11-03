SET LOCAL lock_timeout='2s';
ALTER TABLE liekan_analysis_generation ADD COLUMN gc_started_at timestamptz;
CREATE INDEX liekan_analysis_generation_gc ON liekan_analysis_generation(website_id,updated_at,generation);
CREATE INDEX liekan_analysis_generation_gc_active ON liekan_analysis_generation(website_id,updated_at,generation) WHERE gc_started_at IS NOT NULL;
CREATE INDEX liekan_analysis_manifest_generation ON liekan_analysis_manifest(website_id,generation);
CREATE INDEX liekan_analysis_manifest_previous ON liekan_analysis_manifest(website_id,previous_generation) WHERE previous_generation IS NOT NULL;
CREATE INDEX liekan_analysis_build_candidate ON liekan_analysis_build(website_id,(checkpoint->>'generation')) WHERE checkpoint->>'generation' IS NOT NULL;

CREATE TABLE liekan_storage_policy (
 scope_key text PRIMARY KEY,
 website_id uuid UNIQUE REFERENCES website(website_id) ON DELETE CASCADE,
 actor_id uuid,
 revision bigint NOT NULL DEFAULT 1,
 settings jsonb NOT NULL,
 next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_daily text,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(scope_key=coalesce(website_id::text,'instance'))
);
CREATE TABLE liekan_storage_cleanup (
 id uuid PRIMARY KEY,
 scope_key text NOT NULL,
 website_id uuid REFERENCES website(website_id) ON DELETE CASCADE,
 actor_id uuid,
 locale text NOT NULL DEFAULT 'zh-CN' CHECK(locale IN('zh-CN','en-US')),
 kind text NOT NULL CHECK(kind IN('manual','scheduled','pressure')),
 status text NOT NULL CHECK(status IN('preview','queued','running','completed','stopped','failed')),
 policy_revision bigint NOT NULL,
 epoch bigint,
 ownership jsonb,
 conditions jsonb NOT NULL,
 request_id uuid NOT NULL UNIQUE,
 request_hash text NOT NULL,
 candidate_count bigint NOT NULL DEFAULT 0,
 protected_count bigint NOT NULL DEFAULT 0,
 estimated_bytes bigint NOT NULL DEFAULT 0,
 rows_deleted bigint NOT NULL DEFAULT 0,
 generations_deleted bigint NOT NULL DEFAULT 0,
 jobs_deleted bigint NOT NULL DEFAULT 0,
 released_bytes bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
 started_at timestamptz,
 completed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 error_code text,
 CHECK(scope_key=coalesce(website_id::text,'instance'))
);
CREATE UNIQUE INDEX liekan_storage_cleanup_active ON liekan_storage_cleanup(scope_key) WHERE status IN('queued','running');
CREATE INDEX liekan_storage_cleanup_history ON liekan_storage_cleanup(scope_key,created_at DESC,id);
CREATE TABLE liekan_storage_candidate (
 run_id uuid NOT NULL REFERENCES liekan_storage_cleanup(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('generation','job')),
 record_id uuid NOT NULL,
 queue_name text,
 PRIMARY KEY(run_id,kind,record_id)
);
CREATE TABLE liekan_storage_operation (
 request_id uuid PRIMARY KEY,
 scope_key text NOT NULL,
 actor_id uuid NOT NULL,
 action text NOT NULL,
 request_hash text NOT NULL,
 response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
