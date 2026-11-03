import { PgBoss, fromPrisma } from 'pg-boss';
import { LiekanError } from '../upstream/errors';
export const QUEUE_SCHEMA = 'liekan_jobs';
export const LOG_QUEUE = 'liekan-log-ingest';
export const PROVIDER_QUEUE = 'liekan-provider-maintenance';
export const BROWSER_RISK_QUEUE = 'liekan-browser-risk';
export const RANGE_QUEUE = 'liekan-range-refresh';
export const DOCUMENT_QUEUE = 'liekan-crawler-documents';
// Six exponential retries span at least 945 seconds with jitter, covering either source lease.
export const CRAWLER_SOURCE_RETRY = Object.freeze({
  retryLimit: 6,
  retryDelay: 30,
  retryBackoff: true,
});
export const CRAWLER_ANALYSIS_QUEUE = 'liekan-crawler-analysis';
export const CRAWLER_CHECK_QUEUE = 'liekan-crawler-check';
export const CRAWLER_CONTROL_QUEUE = 'liekan-crawler-control';
export const DEAD_QUEUE = 'liekan-dead-letter';
let queuePromise: Promise<PgBoss> | undefined;
export function getQueue() {
  queuePromise ||= (async () => {
    const boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      schema: QUEUE_SCHEMA,
      migrate: false,
      max: 4,
      schedule: false,
      supervise: false,
    });
    // Only emit a fixed diagnostic; library errors can contain connection details.
    boss.on('error', () => console.error('Liekan queue connection failed'));
    try {
      await boss.start();
      return boss;
    } catch {
      await boss.stop().catch(() => {});
      throw new LiekanError('持久日志队列未就绪', 503);
    }
  })().catch(error => {
    queuePromise = undefined;
    throw error;
  });
  return queuePromise;
}

/** Close the producer's own pg-boss timers/pool after background work drains. */
export async function closeQueue() {
  const pending = queuePromise;
  queuePromise = undefined;
  const boss = await pending?.catch(() => undefined);
  await boss?.stop({ graceful: true, timeout: 30000 });
}
export async function enqueue(tx: any, queue: string, data: object, id?: string) {
  const boss = await getQueue();
  await boss.send(queue, data, {
    db: fromPrisma(tx),
    ...(id ? { id } : {}),
    retryLimit: 12,
    retryDelay: 5,
    retryBackoff: true,
    expireInSeconds: 120,
    retentionSeconds: 7 * 86400,
  });
}
