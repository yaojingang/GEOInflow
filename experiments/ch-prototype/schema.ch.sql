CREATE DATABASE IF NOT EXISTS liekan_ch_proto;
CREATE TABLE IF NOT EXISTS liekan_ch_proto.landing (
 run String, attempt String, site String, session String, identity_key String,
 event_id String, partition UInt32, offset_id UInt64, epoch UInt64,
 fingerprint String, verdict String, original_id String, original_session String,
 original_visit String, payload String
) ENGINE=MergeTree ORDER BY (run,site,identity_key,attempt,event_id)
SETTINGS fsync_after_insert=1, fsync_part_directory=1;
CREATE TABLE IF NOT EXISTS liekan_ch_proto.events (
 run String, site String, logical_attempt String, candidate String, event_id String,
 session String, version UInt64, epoch UInt64, partition UInt32, offset_id UInt64, kind String, scope String DEFAULT 'browser', policy_version UInt32 DEFAULT 1
) ENGINE=MergeTree ORDER BY (run,site,candidate,event_id)
SETTINGS fsync_after_insert=1, fsync_part_directory=1;
CREATE TABLE IF NOT EXISTS liekan_ch_proto.properties (
 run String, site String, candidate String, event_id String, name String, value String
) ENGINE=MergeTree ORDER BY (run,site,candidate,event_id,name)
SETTINGS fsync_after_insert=1, fsync_part_directory=1;
CREATE TABLE IF NOT EXISTS liekan_ch_proto.revenue (
 run String, site String, candidate String, event_id String, cents Int64
) ENGINE=MergeTree ORDER BY (run,site,candidate,event_id)
SETTINGS fsync_after_insert=1, fsync_part_directory=1;
CREATE TABLE IF NOT EXISTS liekan_ch_proto.manifest (
 run String, site String, publication String, logical_attempt String, candidate String
) ENGINE=MergeTree ORDER BY (run,site,publication,logical_attempt,candidate)
SETTINGS fsync_after_insert=1, fsync_part_directory=1;

ALTER TABLE liekan_ch_proto.events ADD COLUMN IF NOT EXISTS scope String DEFAULT 'browser';
ALTER TABLE liekan_ch_proto.events ADD COLUMN IF NOT EXISTS policy_version UInt32 DEFAULT 1;
