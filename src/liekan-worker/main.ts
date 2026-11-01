import {
  HISTORY_REPAIR_ENGINE,
  HISTORY_REPAIR_QUEUE,
} from '../lib/liekan/contracts/history-repair';
import {
  processHistoryRepairJob,
  reconcileHistoryRepairs,
} from '../lib/liekan/upstream/history-repair';
import {
  initializeCrawlerRegistry,
  withPublishedRegistry,
} from '../lib/liekan/upstream/crawler-registry-context';
import { invalidateCrawlerWorkflowForRollback } from '../lib/liekan/upstream/workflow-retention';
import { pruneTrafficObservations } from '../lib/liekan/upstream/observation-retention';
import { maintainGeography } from '../lib/liekan/geography/update';
import 'dotenv/config';
import { processBrowserRisk } from '../lib/liekan/upstream/browser-risk';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import prisma from '../lib/prisma';
import { query, transaction, LiekanError } from '../lib/liekan/upstream/server';
import {
  QUEUE_SCHEMA,
  LOG_QUEUE,
  PROVIDER_QUEUE,
  RANGE_QUEUE,
  DOCUMENT_QUEUE,
  CRAWLER_SOURCE_RETRY,
  BROWSER_RISK_QUEUE,
  CRAWLER_ANALYSIS_QUEUE,
  CRAWLER_CHECK_QUEUE,
  CRAWLER_CONTROL_QUEUE,
} from '../lib/liekan/log-ingestion/queue';
import { reconcilePermissions } from '../lib/liekan/log-ingestion/maintenance';
import { recoverBatches } from '../lib/liekan/log-ingestion/recovery';
import { processBatch } from '../lib/liekan/log-ingestion/service';
import { cleanupExpiredAuthorizations } from '../lib/liekan/log-ingestion/cloudflare';
import { maintainProvider } from '../lib/liekan/log-ingestion/provider';
import { sealPlatformSecret, openPlatformSecret } from '../lib/liekan/log-ingestion/secrets';
import { refreshRanges } from '../lib/liekan/log-ingestion/ranges';
import { refreshDocumentSources } from '../lib/liekan/upstream/crawler-maintenance';
import { DOCUMENT_JOB_SECONDS } from '../lib/liekan/crawlers/document-sources';
import { processCrawlerAnalysis } from '../lib/liekan/crawlers/worker';
import { processCrawlerCheck } from '../lib/liekan/crawler-control/diagnostics';
import { processRobotsManagement } from '../lib/liekan/upstream/robots-management';
import { maintainCrawlerRecords } from '../lib/liekan/crawler-control/retention';
import { processCrawlerDeployment } from '../lib/liekan/crawler-control/deployments';

import { pauseRestoredCrawlerControl } from '../lib/liekan/crawler-control/restore';

const workerId = randomUUID();
// Rollback candidates can keep ingestion running while leaving maintenance jobs queued.
const crawlerMaintenancePaused = process.argv.includes('--pause-crawler-maintenance');
const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  schema: QUEUE_SCHEMA,
  migrate: false,
  max: 8,
  schedule: false,
  supervise: true,
});
boss.on('error', () => console.error('Liekan worker queue unavailable'));
let stopped = false,
  maintaining = false;
async function recordHealth() {
  await transaction(tx =>
    tx.$executeRawUnsafe(
      'INSERT INTO liekan_worker_state(id,heartbeat_at,version) VALUES($1,now(),$2) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),version=EXCLUDED.version',
      workerId,
      HISTORY_REPAIR_ENGINE,
    ),
  );
  await writeFile('/tmp/liekan-worker-heartbeat', String(Date.now()), { mode: 0o600 });
}
async function reconcile() {
  if (maintaining || stopped) return;
  maintaining = true;
  try {
    await transaction(async tx => {
      await tx.$executeRawUnsafe(
        'INSERT INTO liekan_worker_state(id,heartbeat_at,version) VALUES($1,now(),$2) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),version=EXCLUDED.version',
        workerId,
        HISTORY_REPAIR_ENGINE,
      );
      await tx.$executeRawUnsafe('DELETE FROM liekan_log_grant WHERE expires_at<now()');
      await tx.$executeRawUnsafe(
        "DELETE FROM liekan_geography_ingress WHERE bucket<now()-interval '90 days'",
      );
      await tx.$executeRawUnsafe(
        "DELETE FROM liekan_ingest_batch WHERE state!='pending' AND received_at<now()-interval '30 days'",
      );
      await tx.$executeRawUnsafe(
        "DELETE FROM liekan_worker_state WHERE heartbeat_at<now()-interval '1 day'",
      );
    });
    const sources = await query(
      "SELECT id,state,credential_hash FROM liekan_log_source WHERE kind='cloudflare' AND provider_config IS NOT NULL ORDER BY last_maintenance_at NULLS FIRST LIMIT 100",
    );
    for (const source of sources) {
      if (stopped) break;
      await maintainProvider(
        source.id,
        source.state === 'disconnected' || !source.credential_hash
          ? 'disconnect'
          : source.state === 'configuring'
            ? 'configure'
            : 'health',
        workerId,
      ).catch(() => {});
    }
  } finally {
    maintaining = false;
  }
}
async function main() {
  if (process.argv.includes('--invalidate-crawler-workflow-once')) {
    console.log(JSON.stringify(await invalidateCrawlerWorkflowForRollback()));
    await prisma.client.$disconnect();
    return;
  }
  if (process.argv.includes('--prune-traffic-observations-once')) {
    console.log(JSON.stringify(await pruneTrafficObservations()));
    await prisma.client.$disconnect();
    return;
  }
  if (process.argv.includes('--observe-browser-risk-once')) {
    await processBrowserRisk();
    await prisma.client.$disconnect();
    console.log('Browser risk observation batch completed');
    return;
  }
  if (process.argv.includes('--pause-crawler-control')) {
    console.log(JSON.stringify(await pauseRestoredCrawlerControl()));
    await prisma.client.$disconnect();
    return;
  }
  if (process.argv.includes('--rekey')) {
    await transaction(async tx => {
      for (const row of await tx.$queryRawUnsafe(
        'SELECT id,provider_config FROM liekan_log_source WHERE provider_config IS NOT NULL FOR UPDATE',
      ))
        await tx.$executeRawUnsafe(
          'UPDATE liekan_log_source SET provider_config=$2 WHERE id=$1::uuid',
          row.id,
          sealPlatformSecret(openPlatformSecret(row.provider_config, row.id), row.id),
        );
      for (const row of await tx.$queryRawUnsafe(
        'SELECT id,payload FROM liekan_log_grant WHERE payload IS NOT NULL FOR UPDATE',
      ))
        await tx.$executeRawUnsafe(
          'UPDATE liekan_log_grant SET payload=$2 WHERE id=$1::uuid',
          row.id,
          sealPlatformSecret(openPlatformSecret(row.payload, row.id), row.id),
        );
      for (const row of await tx.$queryRawUnsafe(
        'SELECT id,payload FROM liekan_oauth_cleanup FOR UPDATE',
      ))
        await tx.$executeRawUnsafe(
          'UPDATE liekan_oauth_cleanup SET payload=$2 WHERE id=$1::uuid',
          row.id,
          sealPlatformSecret(openPlatformSecret(row.payload, row.id), row.id),
        );
      for (const row of await tx.$queryRawUnsafe(
        'SELECT id,website_id,token_encrypted FROM liekan_crawler_connection WHERE token_encrypted IS NOT NULL FOR UPDATE',
      ))
        await tx.$executeRawUnsafe(
          'UPDATE liekan_crawler_connection SET token_encrypted=$2 WHERE id=$1::uuid',
          row.id,
          sealPlatformSecret(
            openPlatformSecret(row.token_encrypted, `crawler-control:${row.id}:${row.website_id}`),
            `crawler-control:${row.id}:${row.website_id}`,
          ),
        );
    });
    await prisma.client.$disconnect();
    console.log('Stored log credentials re-encrypted.');
    return;
  }
  await initializeCrawlerRegistry();
  await boss.start();
  await boss.work<{ runId: string }>(
    HISTORY_REPAIR_QUEUE,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2 },
    async jobs => {
      for (const job of jobs) await processHistoryRepairJob(job.data);
    },
  );
  let repairing = false;
  const repairMaintenance = async () => {
    if (repairing || stopped) return;
    repairing = true;
    try {
      await reconcileHistoryRepairs();
    } finally {
      repairing = false;
    }
  };
  void repairMaintenance().catch(() => console.error('History repair maintenance unavailable'));
  const repairTimer = setInterval(() => {
    void repairMaintenance().catch(() => console.error('History repair maintenance unavailable'));
  }, 60000);
  await boss.work<{ batchId: string }>(
    LOG_QUEUE,
    { localConcurrency: 4, batchSize: 1, pollingIntervalSeconds: 1 },
    async jobs => {
      for (const job of jobs) {
        try {
          await processBatch(job.data.batchId);
        } catch (error) {
          if (error instanceof LiekanError && [401, 403, 404, 409].includes(error.status)) {
            await transaction(tx =>
              tx.$executeRawUnsafe(
                "UPDATE liekan_ingest_batch SET state='failed',payload=NULL,errors='[{\"reason\":\"source-or-event-invalid\"}]'::jsonb WHERE id=$1::uuid AND state='pending'",
                job.data.batchId,
              ),
            );
          } else throw new Error('Log batch processing failed');
        }
      }
    },
  );
  await boss.work<{ sourceId: string; action: 'configure' | 'disconnect' | 'health' }>(
    PROVIDER_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async jobs => {
      for (const job of jobs) await maintainProvider(job.data.sourceId, job.data.action, workerId);
    },
  );
  if (!crawlerMaintenancePaused)
    await boss.work(RANGE_QUEUE, { batchSize: 1 }, async () => {
      await withPublishedRegistry(() => refreshRanges());
    });
  if (!crawlerMaintenancePaused)
    await boss.work(DOCUMENT_QUEUE, { batchSize: 1, localConcurrency: 1 }, async () => {
      await withPublishedRegistry(() => refreshDocumentSources());
    });
  if (!crawlerMaintenancePaused)
    await boss.work(
      CRAWLER_ANALYSIS_QUEUE,
      { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
      async () => {
        await withPublishedRegistry(() => processCrawlerAnalysis(workerId));
      },
    );
  await boss.work(
    CRAWLER_CHECK_QUEUE,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
    async () => {
      await processCrawlerCheck(workerId);
    },
  );
  await boss.work(
    CRAWLER_CONTROL_QUEUE,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
    async () => {
      await processCrawlerDeployment(workerId);
    },
  );
  await boss.work(
    BROWSER_RISK_QUEUE,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
    async () => {
      await processBrowserRisk();
    },
  );
  const wakeBrowserRisk = () =>
    boss.send(
      BROWSER_RISK_QUEUE,
      {},
      {
        singletonKey: 'observe',
        singletonSeconds: 10,
        expireInSeconds: 300,
        retentionSeconds: 3600,
        retryLimit: 2,
      },
    );
  void wakeBrowserRisk().catch(() => {});
  const browserRiskTimer = setInterval(() => {
    void wakeBrowserRisk().catch(() => {});
  }, 10000);
  const wakeCrawlers = async () => {
    for (const queue of [CRAWLER_ANALYSIS_QUEUE, CRAWLER_CHECK_QUEUE, CRAWLER_CONTROL_QUEUE].filter(
      queue => !crawlerMaintenancePaused || queue !== CRAWLER_ANALYSIS_QUEUE,
    ))
      await boss.send(
        queue,
        {},
        {
          singletonKey: 'wake',
          singletonSeconds: 2,
          expireInSeconds: 300,
          retentionSeconds: 3600,
          retryLimit: 2,
        },
      );
  };
  void wakeCrawlers().catch(() => {});
  const crawlerTimer = setInterval(() => {
    void wakeCrawlers().catch(() => {});
  }, 2000);
  let robotsPending: Promise<void> | undefined;
  const wakeRobots = () => {
    if (stopped || robotsPending) return;
    robotsPending = processRobotsManagement()
      .catch(() => console.error('Robots management maintenance unavailable'))
      .finally(() => {
        robotsPending = undefined;
      });
  };
  wakeRobots();
  const robotsTimer = setInterval(wakeRobots, 2000);
  await recordHealth();
  void reconcile().catch(() => console.error('Liekan worker maintenance unavailable'));
  if (!crawlerMaintenancePaused)
    await boss.send(
      RANGE_QUEUE,
      {},
      {
        singletonKey: 'official',
        singletonSeconds: 3600,
        expireInSeconds: 600,
        ...CRAWLER_SOURCE_RETRY,
      },
    );
  // Startup and hourly wakeups catch missed jobs; persisted document due dates stay seven days apart.
  const wakeDocuments = async () => {
    if (crawlerMaintenancePaused || stopped) return;
    await boss.send(
      DOCUMENT_QUEUE,
      {},
      {
        singletonKey: 'documents',
        singletonSeconds: 3600,
        expireInSeconds: DOCUMENT_JOB_SECONDS,
        retentionSeconds: 7 * 86400,
        ...CRAWLER_SOURCE_RETRY,
      },
    );
  };
  await wakeDocuments();
  const documents = setInterval(() => {
    void wakeDocuments().catch(() => {});
  }, 3600000);
  let checkingPermissions = false;
  let recovering = false;
  const recovery = async () => {
    if (recovering || stopped) return;
    recovering = true;
    try {
      await recoverBatches();
    } finally {
      recovering = false;
    }
  };
  void recovery().catch(() => {});
  const recoveryTimer = setInterval(() => {
    void recovery().catch(() => {});
  }, 30000);
  const permissions = async () => {
    if (checkingPermissions || stopped) return;
    checkingPermissions = true;
    try {
      await reconcilePermissions();
    } finally {
      checkingPermissions = false;
    }
  };
  void permissions().catch(() => {});
  const permissionTimer = setInterval(() => {
    void permissions().catch(() => {});
  }, 15000);
  let cleaning = false;
  const cleanup = async () => {
    if (cleaning || stopped) return;
    cleaning = true;
    try {
      await cleanupExpiredAuthorizations(workerId);
      await maintainCrawlerRecords();
      await pruneTrafficObservations().catch(() =>
        console.error('traffic_observation_retention_failed'),
      );
      await maintainGeography();
    } finally {
      cleaning = false;
    }
  };
  void cleanup().catch(() => {});
  const cleanupTimer = setInterval(() => {
    void cleanup().catch(() => {});
  }, 30000);
  const health = setInterval(() => {
    void reconcile().catch(() => console.error('Liekan worker maintenance unavailable'));
  }, 30000);
  const heartbeat = setInterval(() => {
    void recordHealth().catch(() => {});
  }, 30000);
  const ranges = setInterval(() => {
    if (crawlerMaintenancePaused) return;
    void boss
      .send(
        RANGE_QUEUE,
        {},
        {
          singletonKey: 'official',
          singletonSeconds: 3600,
          expireInSeconds: 600,
          ...CRAWLER_SOURCE_RETRY,
        },
      )
      .catch(() => {});
  }, 3600000);
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(repairTimer);
    clearInterval(permissionTimer);
    clearInterval(recoveryTimer);
    clearInterval(cleanupTimer);
    clearInterval(health);
    clearInterval(heartbeat);
    clearInterval(ranges);
    clearInterval(documents);
    clearInterval(crawlerTimer);
    clearInterval(robotsTimer);
    clearInterval(browserRiskTimer);
    await boss.stop({ graceful: true, timeout: 30000 });
    await robotsPending;
    await transaction(tx =>
      tx.$executeRawUnsafe('DELETE FROM liekan_worker_state WHERE id=$1', workerId),
    ).catch(() => {});
    await prisma.client.$disconnect();
  };
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
}
main().catch(async () => {
  console.error('Liekan worker startup failed');
  await boss.stop().catch(() => {});
  await prisma.client.$disconnect();
  process.exitCode = 1;
});
