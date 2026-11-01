CREATE TABLE liekan_robots_state (
  website_id uuid PRIMARY KEY REFERENCES website(website_id) ON DELETE CASCADE,
  draft text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1,
  monitor boolean NOT NULL DEFAULT false,
  interval_minutes integer NOT NULL DEFAULT 60 CHECK (interval_minutes IN (15,60,360)),
  monitor_actor uuid,
  context text,
  hostname text,
  next_check timestamptz NOT NULL DEFAULT now(),
  check_lease uuid,
  checking_until timestamptz,
  observed_content text,
  observed_hostname text,
  observed_status integer,
  observed_hash varchar(64),
  checked_at timestamptz,
  last_read_at timestamptz,
  last_error text,
  change_pending boolean NOT NULL DEFAULT false,
  agent_id uuid,
  agent_enabled boolean NOT NULL DEFAULT false,
  credential_hash varchar(64),
  agent_actor uuid,
  agent_context text,
  agent_seen_at timestamptz,
  agent_content text,
  agent_hash varchar(64),
  target_path text,
  pair_hash varchar(64),
  pair_expires timestamptz,
  pair_actor uuid,
  pair_context text,
  CHECK (octet_length(draft)<=262144),
  CHECK (octet_length(agent_content)<=262144),
  CHECK (octet_length(observed_content)<=262144)
);
CREATE TABLE liekan_robots_snapshot (
  id uuid PRIMARY KEY,
  website_id uuid NOT NULL REFERENCES website(website_id) ON DELETE CASCADE,
  content text,
  hostname text NOT NULL,
  status integer NOT NULL,
  digest varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(content)<=262144)
);
CREATE INDEX liekan_robots_snapshot_site ON liekan_robots_snapshot(website_id,created_at DESC);
CREATE UNIQUE INDEX liekan_robots_credential ON liekan_robots_state(credential_hash) WHERE credential_hash IS NOT NULL;
CREATE UNIQUE INDEX liekan_robots_pair ON liekan_robots_state(pair_hash) WHERE pair_hash IS NOT NULL;
CREATE INDEX liekan_robots_monitor_due ON liekan_robots_state(next_check) WHERE monitor;
CREATE TABLE liekan_robots_deployment (
  id uuid PRIMARY KEY,
  website_id uuid NOT NULL REFERENCES website(website_id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  context text NOT NULL,
  hostname text NOT NULL,
  revision integer NOT NULL,
  expected_hash varchar(64) NOT NULL,
  target_hash varchar(64) NOT NULL,
  before_content text,
  content text,
  rollback_of uuid REFERENCES liekan_robots_deployment(id),
  state text NOT NULL CHECK (state IN ('preview','queued','leased','applied','verified','verification_failed','conflict','failed','unknown','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
  lease_until timestamptz,
  applied_at timestamptz,
  verify_after timestamptz,
  verify_deadline timestamptz,
  verified_at timestamptz,
  error_code text,
  CHECK (octet_length(content)<=262144),
  CHECK (octet_length(before_content)<=262144)
);
CREATE INDEX liekan_robots_deployment_site ON liekan_robots_deployment(website_id,created_at DESC);
CREATE UNIQUE INDEX liekan_robots_deployment_active ON liekan_robots_deployment(website_id) WHERE state IN ('queued','leased','applied','unknown');
CREATE INDEX liekan_robots_verify_due ON liekan_robots_deployment(verify_after) WHERE state='applied';
CREATE INDEX liekan_robots_receipt_due ON liekan_robots_deployment(lease_until) WHERE state='leased';
CREATE INDEX liekan_robots_queue_expiry ON liekan_robots_deployment(expires_at) WHERE state='queued';
