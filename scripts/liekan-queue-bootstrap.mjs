import 'dotenv/config';
import { createHash } from 'node:crypto';
import { PgBoss, getConstructionPlans } from 'pg-boss';
import pg from 'pg';

const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') || 'public';
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid business schema');
const checksum = createHash('sha256').update(getConstructionPlans('liekan_jobs')).digest('hex');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  schema: 'liekan_jobs',
  migrate: true,
  schedule: false,
  supervise: false,
  max: 2,
});
boss.on('error', () => console.error('Queue bootstrap connection failed'));
try {
  await client.connect();
  await client.query('SELECT pg_advisory_lock(12800002)');
  await client.query(`SET search_path TO "${schema}"`);
  const old = (
    await client.query(
      "SELECT package_version,checksum FROM liekan_queue_installation WHERE id='liekan_jobs'",
    )
  ).rows[0];
  if (old && (old.package_version !== '12.36.0' || old.checksum !== checksum))
    throw new Error('Queue version changed; a controlled migration is required');
  await boss.start();
  await boss.createQueue('liekan-dead-letter', { retentionSeconds: 7 * 86400 });
  try {
    await boss.createQueue('liekan-analytics-refresh', {
      policy: 'exclusive',
      retryLimit: 2,
      retryDelay: 5,
      retryBackoff: false,
      expireInSeconds: 45,
      retentionSeconds: 3600,
      deleteAfterSeconds: 86400,
    });
  } catch {
    console.error('Analytics preheat unavailable; foreground reads remain enabled');
  }
  for (const name of ['liekan-analysis-query', 'liekan-analysis-build']) {
    const options = {
      retryLimit: 0,
      expireInSeconds: 120,
      retentionSeconds: 60,
      deleteAfterSeconds: 3600,
    };
    await boss.createQueue(name, { ...options, policy: 'exclusive' });
    await boss.updateQueue(name, options);
  }
  const geoOptions = {
    retryLimit: 0,
    expireInSeconds: 120,
    retentionSeconds: 86400,
    deleteAfterSeconds: 86400,
  };
  await boss.createQueue('liekan-geo-weight-snapshot', geoOptions);
  await boss.updateQueue('liekan-geo-weight-snapshot', geoOptions);
  for (const name of ['liekan-log-ingest', 'liekan-provider-maintenance', 'liekan-range-refresh']) {
    await boss.createQueue(name, {
      retryLimit: 12,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: name === 'liekan-range-refresh' ? 600 : 120,
      retentionSeconds: 7 * 86400,
      deadLetter: 'liekan-dead-letter',
    });
  }
  const historyRepairOptions = {
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    expireInSeconds: 120,
    retentionSeconds: 7 * 86400,
    deadLetter: 'liekan-dead-letter',
  };
  await boss.createQueue('liekan-history-repair', historyRepairOptions);
  await boss.updateQueue('liekan-history-repair', historyRepairOptions);
  // Match worker send options and update existing queues when upgrading.
  const sourceRetry = { retryLimit: 6, retryDelay: 30, retryBackoff: true };
  await boss.updateQueue('liekan-range-refresh', { expireInSeconds: 600, ...sourceRetry });
  await boss.createQueue('liekan-crawler-documents', {
    policy: 'short',
    ...sourceRetry,
    expireInSeconds: 900,
    retentionSeconds: 7 * 86400,
    deadLetter: 'liekan-dead-letter',
  });
  await boss.updateQueue('liekan-crawler-documents', { expireInSeconds: 900, ...sourceRetry });
  for (const name of [
    'liekan-browser-risk',
    'liekan-crawler-analysis',
    'liekan-crawler-check',
    'liekan-crawler-control',
  ]) {
    await boss.createQueue(name, {
      policy: 'short',
      retryLimit: 2,
      retryDelay: 5,
      expireInSeconds: 300,
      retentionSeconds: 3600,
    });
  }
  // Completed-only retention belongs to the reviewed storage policy. Native expiry still
  // handles queued, failed and cancelled records using their original queue settings.
  await client.query(`CREATE OR REPLACE TRIGGER liekan_completed_retention_guard
    BEFORE DELETE ON liekan_jobs.job FOR EACH ROW
    EXECUTE FUNCTION "${schema}".liekan_storage_guard_completed_job()`);
  await client.query(`CREATE OR REPLACE TRIGGER liekan_completed_policy_owner
    BEFORE UPDATE OF state ON liekan_jobs.job FOR EACH ROW
    EXECUTE FUNCTION "${schema}".liekan_storage_complete_job()`);
  await client.query(
    "INSERT INTO liekan_queue_installation(id,package_version,checksum) VALUES ('liekan_jobs','12.36.0',$1) ON CONFLICT DO NOTHING",
    [checksum],
  );
  console.log('Liekan fixed queues initialized');
} catch {
  console.error('Liekan queue initialization failed; verify migrations and pinned queue version');
  process.exitCode = 1;
} finally {
  await boss.stop().catch(() => {});
  await client.end().catch(() => {});
}
