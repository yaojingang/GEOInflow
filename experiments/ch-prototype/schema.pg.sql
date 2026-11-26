CREATE TABLE IF NOT EXISTS proto_identity(name text PRIMARY KEY CHECK(name='liekan_ch_proto'));
INSERT INTO proto_identity VALUES ('liekan_ch_proto') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS proto_site(
 run text, site text, epoch bigint NOT NULL DEFAULT 0, revision bigint NOT NULL DEFAULT 0,
 version bigint NOT NULL DEFAULT 0, publication text NOT NULL DEFAULT '',
 PRIMARY KEY(run,site));
CREATE TABLE IF NOT EXISTS proto_partition(
 run text, partition int, generation bigint NOT NULL DEFAULT 0,
 discovered bigint NOT NULL DEFAULT 0, PRIMARY KEY(run,partition));
-- Temporary work references only. Payload remains in the durable input topic.
CREATE TABLE IF NOT EXISTS proto_work(
 run text, partition int, offset_id bigint, site text, session text, identity_key text,
 status text NOT NULL DEFAULT 'pending', attempt text,
 PRIMARY KEY(run,partition,offset_id));
CREATE TABLE IF NOT EXISTS proto_attempt(
 run text, id text, partition int, generation bigint, site text, session text,
 epoch bigint, revision bigint, version bigint, status text NOT NULL DEFAULT 'intent',
 candidate text, published boolean NOT NULL DEFAULT false,
 PRIMARY KEY(run,id));
CREATE TABLE IF NOT EXISTS proto_delete(
 run text, id text, site text, session text, version bigint, status text DEFAULT 'pending',
 topic text, topic_id text, boundary jsonb, reset boolean NOT NULL DEFAULT false,
 PRIMARY KEY(run,id));
CREATE TABLE IF NOT EXISTS proto_migration(
 run text PRIMARY KEY, state text NOT NULL DEFAULT 'capture', generation bigint NOT NULL DEFAULT 1,
 sender_generation bigint NOT NULL DEFAULT 1, terminal_seq bigint, terminal_offsets jsonb);
-- Temporary migration-only transactional outbox. Never part of the final ingestion path.
CREATE TABLE IF NOT EXISTS proto_result(
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run text, op text,
 site text, version bigint, kind text, payload jsonb NOT NULL, sent boolean NOT NULL DEFAULT false,
 transport_offset bigint, UNIQUE(run,op));
CREATE TABLE IF NOT EXISTS proto_shadow_operation(
 run text, op text, site text, version bigint, PRIMARY KEY(run,op));
CREATE TABLE IF NOT EXISTS proto_shadow_fact(
 run text, id text, site text, session text, version bigint, epoch bigint,
 partition int, offset_id bigint, amount bigint, PRIMARY KEY(run,id));
CREATE TABLE IF NOT EXISTS proto_shadow_delete(
 run text, id text, site text, session text, version bigint, boundary jsonb, reset boolean,
 PRIMARY KEY(run,id));

CREATE TABLE IF NOT EXISTS proto_topic(run text,topic text,identity text NOT NULL,PRIMARY KEY(run,topic));
ALTER TABLE proto_topic ADD COLUMN IF NOT EXISTS partitions integer NOT NULL DEFAULT 2;
ALTER TABLE proto_topic ADD COLUMN IF NOT EXISTS routing_version integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS proto_work_active_key ON proto_work(run,identity_key) WHERE status='working';
CREATE TABLE IF NOT EXISTS proto_quarantine(
 run text,partition integer,offset_id bigint,reason text NOT NULL,
 PRIMARY KEY(run,partition,offset_id));
