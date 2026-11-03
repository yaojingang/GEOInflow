import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { PgBoss } from 'pg-boss';

const url = new URL(process.env.DATABASE_URL || 'http://invalid');
if (
  process.env.LIEKAN_STORAGE_CLONE_TEST !== '1' ||
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.pathname !== '/liekan_storage_test'
)
  throw new Error('Storage clone test requires its dedicated loopback test database');
process.env.CLICKHOUSE_URL = '';
process.env.REDIS_URL = '';
process.env.LIEKAN_ANALYTICS_REDIS_URL = '';
process.env.DATABASE_REPLICA_URL = '';
const folder = resolve(process.env.LIEKAN_STORAGE_OUTPUT || '.local/storage-retention');
const phase = process.argv[2] || 'baseline';
const client = new Client({ connectionString: url.toString() });
const boss = new PgBoss({
  connectionString: url.toString(),
  schema: 'liekan_jobs',
  migrate: false,
  schedule: false,
  supervise: false,
  max: 2,
});
const { readStorageState, storageAction, processStorageRun, readStorageRun } = await import(
  '../../src/lib/liekan/upstream/storage-retention'
);
const { readPageReport } = await import('../../src/lib/liekan/upstream/page-report');
const { analyticsWorkerContext, withoutQueryCache } = await import(
  '../../src/lib/liekan/upstream/cache-context'
);
const { default: prisma } = await import('../../src/lib/prisma');
const stable = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (name, item) =>
      ['generatedAt', 'expiresAt'].includes(name) ? undefined : item,
    ),
  );
await mkdir(folder, { recursive: true, mode: 0o700 });
await client.connect();
await boss.start();
try {
  const {
    rows: [website],
  } = await client.query(
    'SELECT website_id AS id,name,domain FROM website WHERE deleted_at IS NULL ORDER BY site_number LIMIT 1',
  );
  const {
    rows: [actor],
  } = await client.query(
    'SELECT user_id AS id FROM "user" WHERE role=\'admin\' AND deleted_at IS NULL LIMIT 1',
  );
  assert(website && actor, 'A restored official example and administrator are required');
  const scope = { websiteId: website.id, actorId: actor.id, locale: 'zh-CN' as const };
  const queries = [
    {
      resource: 'ai/bots',
      startAt: +new Date('2026-10-19T16:00:00Z'),
      endAt: +new Date('2026-10-20T16:00:00Z'),
      timezone: 'Asia/Shanghai',
      chartPeriod: 'today',
    },
    {
      resource: 'human/search-engines',
      startAt: +new Date('2026-10-19T16:00:00Z'),
      endAt: +new Date('2026-10-20T16:00:00Z'),
      timezone: 'Asia/Shanghai',
      chartPeriod: 'today',
    },
    {
      resource: 'human/geo',
      startAt: +new Date('2026-10-19T16:00:00Z'),
      endAt: +new Date('2026-10-20T16:00:00Z'),
      timezone: 'Asia/Shanghai',
      chartPeriod: 'today',
    },
  ];
  async function snapshot() {
    const { rows: tables } =
      await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND
      (tablename IN('website_event','session','event_data','session_data','revenue','heatmap_event','session_replay','liekan_log','liekan_crawler_evidence','liekan_analysis_manifest','liekan_dashboard_snapshot','liekan_analytics_revision','liekan_log_state')
       OR tablename LIKE 'liekan_event_%' OR tablename LIKE 'liekan_history_repair_%' OR tablename LIKE 'liekan_geo_weight_%' OR tablename LIKE 'liekan_traffic_%') ORDER BY tablename`);
    const result: Record<string, unknown> = {};
    for (const { tablename } of tables) {
      assert(/^[a-z_]+$/.test(tablename));
      const {
        rows: [row],
      } = await client.query(
        `SELECT count(*)::text AS count,md5(coalesce(string_agg(md5(t::text),'' ORDER BY md5(t::text)),'')) AS digest FROM "${tablename}" t`,
      );
      result[tablename] = row;
    }
    for (const table of [
      'liekan_analysis_log',
      'liekan_analysis_path',
      'liekan_analysis_visit',
      'liekan_analysis_browser_detail',
      'liekan_analysis_browser_visit',
      'liekan_analysis_browser_path',
    ]) {
      const {
        rows: [row],
      } = await client.query(
        `SELECT count(*)::text AS count,md5(coalesce(string_agg(md5(f::text),'' ORDER BY md5(f::text)),'')) AS digest FROM ${table} f WHERE EXISTS(SELECT 1 FROM liekan_analysis_manifest m WHERE m.website_id=f.website_id AND (m.generation=f.generation OR m.previous_generation=f.generation))`,
      );
      result[`published:${table}`] = row;
    }
    const reports = [];
    for (const query of queries) {
      const result = await analyticsWorkerContext(
        actor.id,
        { private: true },
        () => withoutQueryCache(() => readPageReport(website, query, true)),
        { kind: 'interactive', refresh: true },
      );
      reports.push(stable(result.value));
    }
    return { tables: result, reports };
  }
  if (phase === 'baseline') {
    const baseline = await snapshot();
    await writeFile(resolve(folder, 'clone-baseline.json'), JSON.stringify(baseline), {
      mode: 0o600,
    });
    console.info(
      JSON.stringify({
        phase,
        tables: Object.keys(baseline.tables).length,
        reports: baseline.reports.length,
      }),
    );
  } else if (phase === 'cleanup') {
    const before = await readStorageState(scope);
    const existing =
      before.runs.find(run => ['queued', 'running'].includes(run.status)) ||
      (before.preview.candidateCount === 0
        ? before.runs.find(run => run.status === 'completed' && run.generationsDeleted > 0)
        : undefined);
    const run =
      existing ||
      ((await storageAction(scope, {
        action: 'preview',
        generationHours: 24,
        completedHours: 24,
        wakeHours: 1,
        requestId: randomUUID(),
      })) as { id: string });
    if (!existing)
      await storageAction(scope, { action: 'confirm', id: run.id, requestId: randomUUID() });
    let batches = 0,
      more = true;
    const started = Date.now();
    while (more) {
      more = await processStorageRun(run.id, boss);
      batches++;
      if (batches % 100 === 0)
        console.info(JSON.stringify({ phase, batches, elapsedMs: Date.now() - started }));
      assert(batches < 20000);
    }
    const generations = await readStorageRun(scope, run.id);
    assert(generations.generationsDeleted > 0 && BigInt(generations.releasedBytes) > 0n);
    const instance = { actorId: actor.id, locale: 'zh-CN' as const };
    const queueState = await readStorageState(instance);
    const existingQueue = queueState.runs.find(run => ['queued', 'running'].includes(run.status));
    const queueRun =
      existingQueue ||
      ((await storageAction(instance, {
        action: 'preview',
        generationHours: 24,
        completedHours: 24,
        wakeHours: 1,
        requestId: randomUUID(),
      })) as { id: string });
    if (!existingQueue)
      await storageAction(instance, {
        action: 'confirm',
        id: queueRun.id,
        requestId: randomUUID(),
      });
    more = true;
    let queueBatches = 0;
    while (more) {
      more = await processStorageRun(queueRun.id, boss);
      queueBatches++;
      assert(queueBatches < 20000);
    }
    const queues = await readStorageRun(instance, queueRun.id);
    assert(queues.jobsDeleted > 0);
    const after = await readStorageState(scope);
    assert(BigInt(after.capacity.siteBytes) <= BigInt(before.capacity.siteBytes));
    assert(BigInt(after.capacity.siteBytes) < (BigInt(after.capacity.siteLimit) * 80n) / 100n);
    const result = {
      generations,
      queues,
      batches,
      queueBatches,
      before: before.capacity,
      after: after.capacity,
      elapsedMs: Date.now() - started,
    };
    await writeFile(resolve(folder, 'clone-cleanup.json'), JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    console.info(
      JSON.stringify({
        phase,
        batches,
        queueBatches,
        generationsDeleted: generations.generationsDeleted,
        jobsDeleted: queues.jobsDeleted,
        releasedBytes: generations.releasedBytes,
        elapsedMs: result.elapsedMs,
      }),
    );
  } else if (phase === 'verify') {
    const before = JSON.parse(await readFile(resolve(folder, 'clone-baseline.json'), 'utf8'));
    const after = await snapshot();
    assert.deepEqual(
      after.tables,
      before.tables,
      'Raw inputs, published facts, snapshots and evidence must stay identical',
    );
    assert.deepEqual(
      after.reports,
      before.reports,
      'Recomputed historical reports must stay identical',
    );
    console.info(
      JSON.stringify({
        phase,
        unchangedTables: Object.keys(after.tables).length,
        identicalReports: after.reports.length,
      }),
    );
  } else throw new Error('Unknown clone test phase');
} finally {
  await boss.stop();
  await client.end();
  await prisma.client.$disconnect();
}
