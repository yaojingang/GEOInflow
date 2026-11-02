import { pumpAnalyticsEngine } from '../lib/liekan/upstream/analytics-engine-worker';
import { probeAnalysisExpansion } from '../lib/liekan/upstream/analysis-expansion';
import { pumpDashboardDemand } from '../lib/liekan/upstream/dashboard-snapshots';
import {
  ANALYSIS_QUERY_QUEUE,
  ANALYSIS_BUILD_QUEUE,
} from '../lib/liekan/upstream/analysis-query-model';
import {
  pumpAnalysisQueries,
  processAnalysisQueryDelivery,
} from '../lib/liekan/upstream/analysis-queries';
import {
  pumpAnalysisBuilds,
  processAnalysisBuild,
} from '../lib/liekan/upstream/analysis-build-queue';
import {
  reconcileAnalysisRollups,
  bootstrapAnalysisHistory,
} from '../lib/liekan/upstream/analysis-rollups-worker';
import { withAnalysisPermit } from '../lib/liekan/upstream/analysis-background';
import {
  GEO_SNAPSHOT_QUEUE,
  processGeoSnapshotJob,
  reconcileGeoSnapshots,
  type GeoSnapshotJob,
} from '../lib/liekan/upstream/geo-weight-snapshots';
import { writeFile } from 'node:fs/promises';
import { PgBoss } from 'pg-boss';
import { QUEUE_SCHEMA } from '../lib/liekan/log-ingestion/queue';
import {
  ANALYTICS_QUEUE,
  type AnalyticsRefreshJob,
  pumpAnalyticsHot,
} from '../lib/liekan/upstream/analytics-hot';
import { analyticsRedis } from '../lib/liekan/upstream/analytics-redis';
import prisma from '../lib/prisma';
import { processAnalyticsRefresh, readAnalyticsHotStrongVersion } from './analytics-refresh';
import { pumpStorageRetention } from '../lib/liekan/upstream/storage-retention';
import { maintainAnalyticsInputSummaries } from '../lib/liekan/upstream/analytics-input-summary';

const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  schema: QUEUE_SCHEMA,
  migrate: false,
  max: 2,
  schedule: false,
  supervise: true,
});
boss.on('error', () => console.error('Liekan analytics queue unavailable'));
let stopped = false,
  pumping = false;
async function pump() {
  if (stopped || pumping) return;
  pumping = true;
  try {
    await pumpAnalysisQueries(boss);
    await bootstrapAnalysisHistory();
    await pumpAnalysisQueries(boss);
    await reconcileAnalysisRollups();
    await pumpDashboardDemand(() => pumpAnalysisQueries(boss));
    await pumpAnalysisQueries(boss);
    await pumpAnalysisBuilds(boss);
    await pumpAnalyticsHot(boss, readAnalyticsHotStrongVersion);
    await maintainAnalyticsInputSummaries();
  } catch {
    /* A maintenance failure leaves persistent hot demand for the next pass. */
  } finally {
    pumping = false;
  }
}
await boss.start();
let storageScheduledAt = Date.now();
const storageMaintenance = setInterval(() => {
  const schedule = Date.now() - storageScheduledAt >= 60000;
  if (schedule) storageScheduledAt = Date.now();
  if (!stopped)
    void pumpStorageRetention(boss, { schedule, manualOnly: !schedule }).catch(() =>
      console.info('storage_cleanup_deferred'),
    );
}, 5000);
void pumpStorageRetention(boss).catch(() => console.info('storage_cleanup_deferred'));
await boss.work<GeoSnapshotJob>(
  GEO_SNAPSHOT_QUEUE,
  { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 },
  async jobs => {
    for (const job of jobs)
      if (!stopped)
        await withAnalysisPermit('interactive', () => processGeoSnapshotJob(job.data, boss));
  },
);
const geoMaintenance = setInterval(() => {
  if (!stopped) {
    void reconcileGeoSnapshots(boss).catch(() => {});
    void probeAnalysisExpansion().catch(() => {});
  }
}, 60000);
void reconcileGeoSnapshots(boss).catch(() => {});
await boss.work<AnalyticsRefreshJob>(
  ANALYTICS_QUEUE,
  { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 },
  async jobs => {
    for (const job of jobs)
      if (!stopped) await withAnalysisPermit('preheat', () => processAnalyticsRefresh(job.data));
  },
);
await boss.work<{ id: string }>(
  ANALYSIS_QUERY_QUEUE,
  { localConcurrency: 2, batchSize: 1, pollingIntervalSeconds: 1, includeMetadata: true },
  async jobs => {
    for (const job of jobs) if (!stopped) await processAnalysisQueryDelivery(job, boss);
  },
);
await boss.work<{ id: string; kind: 'history' | 'incremental' }>(
  ANALYSIS_BUILD_QUEUE,
  { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 },
  async jobs => {
    for (const job of jobs)
      if (!stopped)
        await processAnalysisBuild(job.data.id, job.data.kind, { shouldStop: () => stopped });
  },
);
const engineMaintenance = setInterval(() => {
  void pumpAnalyticsEngine().catch(() => {});
}, 5000);
void pumpAnalyticsEngine().catch(() => {});
const maintenance = setInterval(() => {
  void pump();
}, 5000);
void pump();
const heartbeat = setInterval(() => {
  void writeFile('/tmp/liekan-analytics-worker-heartbeat', String(Date.now()), { mode: 0o600 });
}, 30000);
await writeFile('/tmp/liekan-analytics-worker-heartbeat', String(Date.now()), { mode: 0o600 });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    stopped = true;
    clearInterval(maintenance);
    clearInterval(engineMaintenance);
    clearInterval(geoMaintenance);
    clearInterval(heartbeat);
    clearInterval(storageMaintenance);
    await boss.stop({ graceful: true });
    analyticsRedis.close();
    await prisma.client.$disconnect();
    process.exit(0);
  });
