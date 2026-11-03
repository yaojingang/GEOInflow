import { randomUUID } from 'node:crypto';
import { hasPermission } from '@/lib/auth';
import { PERMISSIONS, ROLES } from '@/lib/constants';
import type { JobAttempt, PgBoss } from 'pg-boss';
import type { AnalysisJob } from '../contracts/analysis-acceleration';
import { getPublishedCatalog } from '../crawlers/published';
import { withPublishedRegistry } from './crawler-registry-context';
import { analysisCapacity, analysisTransaction } from './analysis-rollups-db';
import { aiExecutor } from './ai-db';
import { authorizeCrawler, type CrawlerActor } from './crawler-access';
import { readAnalyticsVersions } from './analytics-revision';
import { websiteCacheTag } from './query-cache';
import {
  analyticsWorkerContext,
  captureBrowserPopulations,
  currentCacheContext,
  noteBrowserPopulation,
} from './cache-context';
import { withAnalysisPermit } from './analysis-background';
import {
  analysisPermitTable,
  analysisPermitPredicate,
  analysisPermitValues,
} from './analysis-permit-context';
import {
  analysisConsumerDemandSql,
  registerAnalysisViewer,
  renewAnalysisViewer,
} from './analysis-viewers';
import { firstPageRange, canReadFirstPage, FIRST_PAGE_BUDGET_MS } from './analysis-page-admission';
import {
  analysisForegroundDemandSql,
  dashboardAnalysisWorkSql,
  dashboardRunnableHeadSql,
  dashboardFirstPageTurnSql,
  pauseIdleDashboardRetries,
  preserveDashboardFailure,
  yieldIdleDashboard,
} from './dashboard-demand';
import {
  analysisDigest,
  decodeAnalysisEnvelope,
  encodeAnalysisEnvelope,
  analysisQueryParameters,
  analysisResultFresh,
  analysisQueryLimits,
  ANALYSIS_QUERY_QUEUE,
  ANALYSIS_RESULT_FORMAT,
  liveAnalysisTargets,
  analysisAttemptPolicy,
} from './analysis-query-model';
import { statisticsCacheTtl } from './cache-policy';
import { pageReportParts } from '../contracts/page-report';
import { LiekanError } from './errors';
import { analysisAttemptDiagnostics, noteAnalysisDelivery } from './analysis-diagnostics';

type Row = {
  id: string;
  website_id: string;
  actor_id: string;
  target: string;
  parameters: Record<string, unknown>;
  query_key: string;
  strong_version: string;
  catalog_version: string | null;
  epoch: bigint;
  status: AnalysisJob['status'];
  forced: boolean;
  locale: 'zh-CN' | 'en-US';
  result: any;
  result_bytes: number;
  queued_at: Date;
  started_at: Date | null;
  next_attempt_at: Date;
  completed_at: Date | null;
  generated_at: Date | null;
  expires_at: Date | null;
  retention_until: Date;
  error_code: string | null;
  lease_token: string | null;
  attempts: number;
  foreground?: boolean;
  fast_attempted_at?: Date | null;
};
export type AnalysisRegistration = (tx: any, row: Row) => Promise<void>;
const date = (value: Date | null) => (value == null ? null : new Date(value).toISOString());
export function analysisJobDto(row: Row): AnalysisJob {
  return {
    id: row.id,
    websiteId: row.website_id,
    status: row.status,
    queuedAt: date(row.queued_at),
    startedAt: date(row.started_at),
    completedAt: date(row.completed_at),
    generatedAt: row.generated_at ? +new Date(row.generated_at) : null,
    expiresAt: row.expires_at ? +new Date(row.expires_at) : null,
    errorCode: row.error_code,
    retryAfterMs:
      row.attempts === 0 || (row.attempts === 1 && row.status === 'running') ? 1000 : 3000,
    resultUrl: `/liekan/websites/${row.website_id}/analytics-jobs/${row.id}/result`,
  };
}
export async function analysisQueryState(tx: any, websiteId: string, actor: CrawlerActor) {
  const website = await authorizeCrawler(aiExecutor(tx), actor, websiteId);
  const [site] = await tx.$queryRawUnsafe(
    'SELECT s.epoch,s.mode,w.site_number AS "siteNumber" FROM liekan_analysis_site s JOIN website w USING(website_id) WHERE s.website_id=$1::uuid',
    websiteId,
  );
  if (!site) throw new LiekanError('统计加速迁移未完成', 503);
  const { strong } = await readAnalyticsVersions(tx, [websiteCacheTag(websiteId)]);
  const canManage = Boolean(
    website.role === ROLES.admin ||
      website.ownerUserId === actor.id ||
      (website.teamRole && (await hasPermission(website.teamRole, PERMISSIONS.websiteUpdate))),
  );
  return {
    website: { ...website, siteNumber: site.siteNumber, canManage },
    epoch: site.epoch,
    mode: site.mode,
    strong,
  };
}
const state = analysisQueryState;
function projected(row: Row, website: any) {
  const result = decodeAnalysisEnvelope(row.result, row.website_id);
  const value = structuredClone(result.value) as any;
  if (row.target === 'feature:page-report' && value) {
    value.website = {
      id: website.id,
      name: website.name,
      domain: website.domain,
      siteNumber: website.siteNumber,
    };
    value.meta = {
      ...value.meta,
      canManage: website.canManage,
      generatedAt: +new Date(row.generated_at),
      expiresAt: +new Date(row.expires_at),
    };
  }
  for (const population of result.populations) noteBrowserPopulation(row.website_id, population);
  return value;
}
/** Transactional outbox: queued business rows remain discoverable until a worker owns them. */
async function requestAnalysisQueryOnce(
  websiteId: string,
  actor: CrawlerActor,
  target: string,
  input: Record<string, unknown>,
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
  registered?: AnalysisRegistration,
  foreground = true,
  admissionDeadline = Infinity,
  shareActive = false,
) {
  const parameters = analysisQueryParameters(target, input),
    forced = input.refresh === '1';
  if (Buffer.byteLength(JSON.stringify(parameters)) > 16384)
    throw new LiekanError('统计条件超出上限', 413);
  return analysisTransaction(async tx => {
    const snapshot = await state(tx, websiteId, actor);
    const key = analysisDigest([
      ANALYSIS_RESULT_FORMAT,
      websiteId,
      target,
      parameters,
      locale,
      snapshot.strong,
      String(snapshot.epoch),
    ]);
    const rows = await tx.$queryRawUnsafe<Row[]>(
      'SELECT * FROM liekan_analysis_query WHERE website_id=$1::uuid AND query_key=$2 AND retention_until>clock_timestamp() ORDER BY sequence DESC LIMIT 20',
      websiteId,
      key,
    );
    let existing = rows.find(
      row =>
        ['queued', 'running'].includes(row.status) &&
        (!forced ||
          shareActive ||
          (row.forced &&
            row.actor_id === actor.id &&
            +new Date(row.queued_at) > Date.now() - 5000)),
    );
    const ready = !forced && !existing && rows.find(row => analysisResultFresh(row));
    if (ready) {
      if (
        (await readAnalyticsVersions(tx, [websiteCacheTag(websiteId)])).strong !== snapshot.strong
      )
        throw new LiekanError('统计条件已变化，请重新读取', 409);
      await registered?.(tx, ready);
      return {
        ready: true as const,
        value: projected(ready, snapshot.website),
        generatedAt: +new Date(ready.generated_at),
        expiresAt: +new Date(ready.expires_at),
      };
    }
    if (existing) {
      const consumer = await tx.$queryRawUnsafe<any[]>(
        `SELECT 1 FROM liekan_analysis_query_consumer c WHERE job_id=$1::uuid AND actor_id=$2::uuid AND ${analysisConsumerDemandSql()}`,
        existing.id,
        actor.id,
      );
      if (consumer.length) {
        await registerAnalysisViewer(tx, existing.id, actor.id);
        await registered?.(tx, existing);
        const [current] = await tx.$queryRawUnsafe<{ id: string }[]>(
          "SELECT id FROM liekan_analysis_query WHERE id=$1::uuid AND status IN('queued','running') FOR SHARE SKIP LOCKED",
          existing.id,
        );
        if (!current)
          throw new LiekanError('统计任务已更新，请重试登记', 503, 'analysis-admission-busy');
        const previous = rows.find(row => row.status === 'ready');
        return {
          ready: false as const,
          analysisJob: analysisJobDto(existing),
          ...(previous ? { previousResult: projected(previous, snapshot.website) } : {}),
        };
      }
    }
    const activeNow = async () =>
      (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM liekan_analysis_query WHERE website_id=$1::uuid AND query_key=$2 AND status IN('queued','running') AND retention_until>clock_timestamp() AND ($3=false OR (forced AND actor_id=$4::uuid AND queued_at>clock_timestamp()-interval '5 seconds')) ORDER BY sequence DESC LIMIT 1`,
          websiteId,
          key,
          forced && !shareActive,
          actor.id,
        )
      )[0];
    const countsNow = () =>
      tx.$queryRawUnsafe<{ global: number; site: number; actor: number }[]>(
        `SELECT count(*)::int AS global,count(*) FILTER(WHERE q.website_id=$1::uuid)::int AS site,
       count(*) FILTER(WHERE (q.target=ANY($3::text[]))=$4::boolean AND EXISTS(SELECT 1 FROM liekan_analysis_query_consumer c WHERE c.job_id=q.id AND c.actor_id=$2::uuid AND ${analysisConsumerDemandSql()}))::int AS actor
       FROM liekan_analysis_query q WHERE q.status IN('queued','running') AND q.retention_until>clock_timestamp()`,
        websiteId,
        actor.id,
        liveAnalysisTargets,
        liveAnalysisTargets.includes(target),
      );
    const joinedNow = async (job: Row | undefined) =>
      Boolean(
        job &&
          (
            await tx.$queryRawUnsafe<any[]>(
              `SELECT 1 FROM liekan_analysis_query_consumer c WHERE job_id=$1::uuid AND actor_id=$2::uuid AND ${analysisConsumerDemandSql()}`,
              job.id,
              actor.id,
            )
          ).length,
      );
    const quotaBlocked = (
      counts: { global: number; site: number; actor: number },
      job: Row | undefined,
      joined: boolean,
    ) =>
      (!job &&
        (counts.global >= analysisQueryLimits.global || counts.site >= analysisQueryLimits.site)) ||
      (!joined && counts.actor >= analysisQueryLimits.actor);
    const concurrencyError = () =>
      new LiekanError(
        '后台统计任务已达上限，请等待当前任务完成',
        429,
        'analysis-concurrency-limited',
      );
    const [lock] = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
      'SELECT pg_try_advisory_xact_lock(1277339412) AS locked',
    );
    if (!lock.locked) {
      // At the existing retry boundary, report a proved quota limit without allocating work.
      if (Date.now() >= admissionDeadline) {
        const active = await activeNow();
        const [counts] = await countsNow();
        if (quotaBlocked(counts, active, await joinedNow(active))) throw concurrencyError();
      }
      throw new LiekanError('统计任务登记繁忙，请稍后重试', 503, 'analysis-admission-busy');
    }
    // Recheck after the global admission lock: another process may have registered the same input.
    existing = await activeNow();
    if (
      forced &&
      rows.some(
        row =>
          row.actor_id === actor.id &&
          row.forced &&
          row.error_code !== 'analysis-idle' &&
          +new Date(row.queued_at) > Date.now() - 5000,
      ) &&
      !existing
    )
      throw new LiekanError('刷新过于频繁，请稍后重试', 429);
    const capacity = await analysisCapacity(tx, websiteId);
    if (
      BigInt(capacity.globalBytes) >= BigInt(capacity.globalLimit) ||
      BigInt(capacity.siteBytes) >= BigInt(capacity.siteLimit)
    )
      throw new LiekanError('统计结果空间已达上限', 503, 'analysis-capacity-limited');
    let [counts] = await countsNow();
    const joined = await joinedNow(existing);
    const concurrencyLimited = () => quotaBlocked(counts, existing, joined);
    if (
      foreground &&
      concurrencyLimited() &&
      (await yieldIdleDashboard(tx, actor.id, websiteId, {
        epoch: snapshot.epoch,
        strong: snapshot.strong,
        targets: liveAnalysisTargets,
        actorClass:
          counts.actor >= analysisQueryLimits.actor ? liveAnalysisTargets.includes(target) : null,
      }))
    )
      [counts] = await countsNow();
    if (concurrencyLimited()) throw concurrencyError();
    let job = existing;
    if (!job) {
      [job] = await tx.$queryRawUnsafe<Row[]>(
        `INSERT INTO liekan_analysis_query(id,website_id,actor_id,target,parameters,query_key,strong_version,catalog_version,epoch,forced,status,locale)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6,$7,$8::uuid,$9::bigint,$10,'queued',$11) RETURNING *`,
        randomUUID(),
        websiteId,
        actor.id,
        target,
        JSON.stringify(parameters),
        key,
        snapshot.strong,
        getPublishedCatalog()?.version || null,
        snapshot.epoch,
        forced,
        locale,
      );
    }
    await registerAnalysisViewer(tx, job.id, actor.id);
    await registered?.(tx, job);
    const previous = rows.find(row => row.status === 'ready');
    return {
      ready: false as const,
      analysisJob: analysisJobDto(job),
      ...(previous ? { previousResult: projected(previous, snapshot.website) } : {}),
    };
  });
}
const registrations = new Map<string, Promise<unknown>>();
export async function requestAnalysisQuery(
  websiteId: string,
  actor: CrawlerActor,
  target: string,
  input: Record<string, unknown>,
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
  registered?: AnalysisRegistration,
  foreground = true,
  options: { shareActive?: boolean } = {},
) {
  const key = analysisDigest([
    websiteId,
    actor.id,
    target,
    input,
    locale,
    getPublishedCatalog()?.version,
    foreground,
    options.shareActive === true,
  ]);
  const pending = registrations.get(key);
  if (pending) await pending.catch(() => {});
  const deadline = Date.now() + 500;
  const run = async () => {
    for (;;) {
      try {
        return await requestAnalysisQueryOnce(
          websiteId,
          actor,
          target,
          input,
          locale,
          registered,
          foreground,
          deadline,
          options.shareActive === true,
        );
      } catch (error) {
        if (!(error instanceof LiekanError) || error.code !== 'analysis-admission-busy')
          throw error;
        if (Date.now() >= deadline)
          // One final check covers a deadline crossed while the refusal was returning.
          return requestAnalysisQueryOnce(
            websiteId,
            actor,
            target,
            input,
            locale,
            registered,
            foreground,
            0,
            options.shareActive === true,
          );
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  };
  const promise = run();
  if (!pending && registrations.size < 128) registrations.set(key, promise);
  try {
    return await promise;
  } finally {
    if (registrations.get(key) === promise) registrations.delete(key);
  }
}
export async function readAnalysisQuery(
  websiteId: string,
  actor: CrawlerActor,
  jobId: string,
  result = false,
) {
  return analysisTransaction(async tx => {
    const snapshot = await state(tx, websiteId, actor);
    const [row] = await tx.$queryRawUnsafe<Row[]>(
      `SELECT q.* FROM liekan_analysis_query q JOIN liekan_analysis_query_consumer c ON c.job_id=q.id AND c.actor_id=$3::uuid
     WHERE q.id=$1::uuid AND q.website_id=$2::uuid FOR KEY SHARE OF q`,
      jobId,
      websiteId,
      actor.id,
    );
    if (!row) throw new LiekanError('统计任务不存在或已过期，请重新读取', 410, 'analysis-expired');
    if (row.strong_version !== snapshot.strong || String(row.epoch) !== String(snapshot.epoch))
      throw new LiekanError('统计条件已变化，请重新读取', 410, 'analysis-invalidated');
    if (
      +new Date(row.retention_until) <= Date.now() ||
      ['invalidated', 'expired'].includes(row.status)
    )
      throw new LiekanError('统计任务已过期，请重新读取', 410, 'analysis-expired');
    if (['queued', 'running'].includes(row.status)) {
      await renewAnalysisViewer(tx, row.id, actor.id);
      await tx.$executeRawUnsafe(
        'UPDATE liekan_dashboard_snapshot SET last_read_at=clock_timestamp() WHERE job_id=$1::uuid',
        row.id,
      );
    }
    if (result && row.status === 'failed')
      throw new LiekanError(
        '后台统计计算失败，请缩小范围或重新读取',
        503,
        row.error_code || 'analysis-failed',
      );
    if (result && row.status === 'ready' && !analysisResultFresh(row))
      throw new LiekanError('统计结果已过期，请重新读取', 410, 'analysis-expired');
    if (
      result &&
      row.status === 'ready' &&
      (await readAnalyticsVersions(tx, [websiteCacheTag(websiteId)])).strong !== snapshot.strong
    )
      throw new LiekanError('统计条件已变化，请重新读取', 410);
    if (result && row.status === 'ready')
      return {
        ready: true as const,
        value: projected(row, snapshot.website),
        generatedAt: +new Date(row.generated_at),
        expiresAt: +new Date(row.expires_at),
      };
    return { ready: false as const, analysisJob: analysisJobDto(row) };
  });
}
export async function pumpAnalysisQueries(boss: Pick<PgBoss, 'send' | 'update'>) {
  const rows = await analysisTransaction(async tx => {
    await tx.$executeRawUnsafe(`UPDATE liekan_analysis_query SET status=CASE WHEN attempts>=4 THEN 'failed' ELSE 'queued' END,error_code='analysis-lease-expired',lease_token=NULL,lease_until=NULL
     WHERE status='running' AND lease_until<=clock_timestamp()`);
    await pauseIdleDashboardRetries(tx);
    await preserveDashboardFailure(tx);
    await tx.$executeRawUnsafe(
      `DELETE FROM liekan_analysis_query WHERE retention_until<=clock_timestamp()`,
    );
    // Preserve every active request; evict only older completed responses.
    await tx.$executeRawUnsafe(
      `DELETE FROM liekan_analysis_query WHERE id IN(SELECT id FROM(SELECT id,row_number() OVER(PARTITION BY website_id ORDER BY sequence DESC) AS rank FROM liekan_analysis_query WHERE status='ready') r WHERE rank>20)`,
    );
    return tx.$queryRawUnsafe<Row[]>(
      `SELECT q.*,${analysisForegroundDemandSql} AS foreground
       FROM liekan_analysis_query q WHERE status='queued' AND next_attempt_at<=clock_timestamp()
       AND q.retention_until>clock_timestamp()
       AND (NOT ${dashboardAnalysisWorkSql} OR ${dashboardRunnableHeadSql})
       ORDER BY foreground DESC,q.queued_at,q.sequence LIMIT 32`,
    );
  });
  for (const row of rows) await handoff(row, boss);
}
async function handoff(row: Row, boss: Pick<PgBoss, 'send' | 'update'>) {
  const priority = row.foreground === false ? 0 : 10;
  // First live deliveries can gain a reader after pickup; pre-arm their bounded contention retries.
  // Delivery retries do not claim the business row or spend a computation attempt.
  const delivery = {
    retryLimit:
      row.foreground !== false || (row.attempts === 0 && liveAnalysisTargets.includes(row.target))
        ? 10
        : 0,
    retryDelay: 1,
    retryBackoff: false,
  };
  const sent = await boss.send(
    ANALYSIS_QUERY_QUEUE,
    { id: row.id },
    {
      singletonKey: row.id,
      priority,
      ...delivery,
      expireInSeconds: 120,
      retentionSeconds: 60,
      deleteAfterSeconds: 3600,
    },
  );
  // Singleton handoffs already in the queue retain their payload and receive current demand priority.
  if (!sent)
    await boss.update(ANALYSIS_QUERY_QUEUE, undefined, {
      singletonKey: row.id,
      priority,
      ...delivery,
    });
}
/** The HTTP boundary can hand off its committed outbox row without waiting for the recovery pump. */
export async function dispatchAnalysisQuery(id: string, boss: Pick<PgBoss, 'send' | 'update'>) {
  const [row] = await analysisTransaction(tx =>
    tx.$queryRawUnsafe<Row[]>(
      `SELECT q.*,${analysisForegroundDemandSql} AS foreground
     FROM liekan_analysis_query q WHERE id=$1::uuid AND status='queued' AND next_attempt_at<=clock_timestamp()
     AND q.retention_until>clock_timestamp()`,
      id,
    ),
  );
  if (row) await handoff(row, boss);
}
async function foregroundDeliveryPending(id: string) {
  const rows = await analysisTransaction(tx =>
    tx.$queryRawUnsafe<any[]>(
      `SELECT 1 FROM liekan_analysis_query q WHERE id=$1::uuid AND status='queued'
       AND next_attempt_at<=clock_timestamp() AND q.retention_until>clock_timestamp()
       AND ${analysisForegroundDemandSql}`,
      id,
    ),
  );
  return rows.length > 0;
}
export async function processAnalysisQuery(id: string, options: { firstPage?: boolean } = {}) {
  const candidate = await analysisTransaction(async tx => {
    await pauseIdleDashboardRetries(tx);
    const [row] = await tx.$queryRawUnsafe<Row[]>(
      `SELECT q.*,${analysisForegroundDemandSql} AS foreground
       FROM liekan_analysis_query q WHERE id=$1::uuid AND status='queued' AND next_attempt_at<=clock_timestamp()
       AND q.retention_until>clock_timestamp()
       ${options.firstPage ? 'AND q.attempts=0 AND q.fast_attempted_at IS NULL AND ' + dashboardFirstPageTurnSql : ''}
       AND (NOT ${dashboardAnalysisWorkSql} OR ${dashboardRunnableHeadSql})`,
      id,
    );
    return row;
  });
  if (
    !candidate ||
    (options.firstPage &&
      (candidate.target !== 'feature:page-report' || !firstPageRange(candidate.parameters)))
  )
    return {
      acquired: false as const,
      value: undefined,
      retryDelivery: await foregroundDeliveryPending(id),
    };
  const policy = analysisAttemptPolicy(candidate);
  // Unviewed prewarming retains low queue priority and the shared heavy slot.
  const foregroundDemand = candidate.foreground !== false;
  let claimed = false;
  const result = await withAnalysisPermit(policy.lane, async (owned, lease) => {
    const row = await analysisTransaction(async tx => {
      const [row] = await tx.$queryRawUnsafe<Row[]>(
        `UPDATE liekan_analysis_query q SET status='running',started_at=clock_timestamp(),lease_token=$2::uuid,
       lease_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1,updated_at=clock_timestamp()
       ${options.firstPage ? ',fast_attempted_at=clock_timestamp()' : ''}
       WHERE id=$1::uuid AND status='queued' AND next_attempt_at<=clock_timestamp()
       AND q.retention_until>clock_timestamp()
       AND attempts=$3::int AND ${analysisForegroundDemandSql}=$4::boolean
       ${options.firstPage ? 'AND attempts=0 AND fast_attempted_at IS NULL AND ' + dashboardFirstPageTurnSql : ''}
       AND (NOT ${dashboardAnalysisWorkSql} OR ${dashboardRunnableHeadSql}) RETURNING q.*`,
        id,
        randomUUID(),
        candidate.attempts,
        foregroundDemand,
      );
      return row;
    });
    if (!row) return;
    claimed = true;
    // started_at belongs to this claim. Retry wait starts at eligibility, with backoff excluded.
    const diagnostics = analysisAttemptDiagnostics(
      row,
      row.next_attempt_at,
      options.firstPage ? 'foreground' : 'worker',
    );
    let failure: unknown;
    let recoveryFailed = false;
    try {
      return await withPublishedRegistry(async () => {
        const actor = { id: row.actor_id, role: '' };
        const allowed = (deadline?: number) =>
          analysisTransaction(
            async tx => {
              const s = await state(tx, row.website_id, actor);
              return s.strong === row.strong_version && String(s.epoch) === String(row.epoch);
            },
            'ReadCommitted',
            deadline,
          );
        if (!(await allowed())) throw new LiekanError('统计条件已变化', 410);
        const { dashboardJobClock, publishDashboardSnapshot } = await import(
          './dashboard-snapshots'
        );
        const { withDashboardClock } = await import('./dashboard-clock');
        const cutoff = await analysisTransaction(tx => dashboardJobClock(tx, row.id));
        const started = Date.now();
        const budgetMs = options.firstPage ? FIRST_PAGE_BUDGET_MS : policy.budgetMs;
        if (
          options.firstPage &&
          !(await canReadFirstPage(row.website_id, row.parameters, started + budgetMs))
        )
          throw new LiekanError('统计转为后台读取', 503, 'analysis-fast-deferred');
        const compute = (refresh: boolean) =>
          diagnostics.compute(() =>
            analyticsWorkerContext(
              row.actor_id,
              { private: true },
              async () => {
                const { executeAnalysisQuery } = await import('./analysis-query-execution');
                const execute = () =>
                  captureBrowserPopulations(() =>
                    executeAnalysisQuery(row.website_id, actor, row.target, row.parameters),
                  );
                try {
                  const result = await (cutoff === undefined
                    ? execute()
                    : withDashboardClock(cutoff, execute));
                  return { ...result, freshness: [...currentCacheContext().results] };
                } finally {
                  diagnostics.sources(currentCacheContext().results);
                }
              },
              {
                kind: 'interactive',
                refresh,
                deadline: started + budgetMs,
                reauthorize: allowed,
              },
            ),
          );
        let result = await compute(row.forced);
        // A short-lived input cache can expire while a later query finishes. Recompute once within the same deadline.
        if (result.freshness.some(item => item.expiresAt <= Date.now() + 5000))
          result = await compute(true);
        if (result.freshness.some(item => item.expiresAt <= Date.now()))
          throw new LiekanError('统计来源结果已过期，请重新计算', 503, 'analysis-source-expired');
        // Native responses are projected through their existing JSON representation.
        const encoded = encodeAnalysisEnvelope(result.value, result.populations, row.website_id);
        if (!owned()) throw new LiekanError('后台计算租约失效', 410);
        const publish = () =>
          analysisTransaction(async tx => {
            const [permit] = await tx.$queryRawUnsafe(
              `SELECT 1 FROM ${analysisPermitTable(lease)} WHERE ${analysisPermitPredicate(lease)} AND lease_until>clock_timestamp() FOR SHARE`,
              ...analysisPermitValues(lease),
            );
            if (!permit) throw new LiekanError('后台计算租约失效', 410);
            const snapshot = await state(tx, row.website_id, actor);
            if (
              snapshot.strong !== row.strong_version ||
              String(snapshot.epoch) !== String(row.epoch)
            )
              throw new LiekanError('统计条件已变化', 410);
            const endAt = Number(
              row.parameters.endAt ?? +new Date(row.parameters.endDate as string),
            );
            // Page-report may include today's dedicated counters even for a historical selection.
            const ttl =
              row.target === 'feature:page-report' &&
              pageReportParts[String(row.parameters.resource)]?.today
                ? 30000
                : statisticsCacheTtl(endAt, String(row.parameters.timezone || 'UTC'));
            const generatedAt = result.freshness.length
              ? Math.min(...result.freshness.map(item => item.generatedAt))
              : started;
            const expiresAt = result.freshness.length
              ? Math.min(...result.freshness.map(item => item.expiresAt))
              : Date.now() + ttl;
            if (expiresAt <= Date.now())
              throw new LiekanError(
                '统计来源结果已过期，请重新计算',
                503,
                'analysis-source-expired',
              );
            // Capacity can change while a task runs. Charge the prospective result before publishing it.
            const capacity = await analysisCapacity(tx, row.website_id);
            if (
              BigInt(capacity.globalBytes) + BigInt(Buffer.byteLength(encoded) * 2) >=
                BigInt(capacity.globalLimit) ||
              BigInt(capacity.siteBytes) + BigInt(Buffer.byteLength(encoded) * 2) >=
                BigInt(capacity.siteLimit)
            )
              throw new LiekanError('统计结果空间已达上限', 413, 'analysis-capacity-limited');
            const published = await tx.$executeRawUnsafe(
              `UPDATE liekan_analysis_query SET status='ready',result=$3::jsonb,result_bytes=$4,generated_at=$5::timestamptz,
           completed_at=clock_timestamp(),expires_at=$6::timestamptz,retention_until=clock_timestamp()+interval '24 hours',
           lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=clock_timestamp()
           WHERE id=$1::uuid AND lease_token=$2::uuid AND status='running' AND lease_until>clock_timestamp() AND $6::timestamptz>clock_timestamp()`,
              row.id,
              row.lease_token,
              encoded,
              Buffer.byteLength(encoded),
              new Date(generatedAt),
              new Date(expiresAt),
            );
            if (published !== 1) {
              if (expiresAt <= Date.now())
                throw new LiekanError(
                  '统计来源结果已过期，请重新计算',
                  503,
                  'analysis-source-expired',
                );
              throw new LiekanError('后台计算租约失效', 410);
            }
            await publishDashboardSnapshot(tx, {
              id: row.id,
              result: JSON.parse(encoded),
              result_bytes: Buffer.byteLength(encoded),
              generated_at: new Date(generatedAt),
            });
            await tx.$executeRawUnsafe(
              `DELETE FROM liekan_analysis_query WHERE website_id=$1::uuid AND id IN(
            SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid AND status='ready' ORDER BY sequence DESC OFFSET 20)`,
              row.website_id,
            );
          });
        await diagnostics.publish(publish);
      }, row.catalog_version || undefined);
    } catch (error) {
      failure = error || new Error('analysis-compute-failed');
      const status = error instanceof LiekanError ? error.status : 500;
      // Acquisition and publication failures remain retryable; budget failures carry an explicit code.
      const code = error instanceof LiekanError ? error.code : 'analysis-compute-failed';
      try {
        if (
          options.firstPage &&
          (code === 'analysis-fast-deferred' ||
            (error instanceof LiekanError && error.status === 503 && code === 'liekan-error') ||
            code === 'analysis-query-timeout' ||
            ['P2028', 'P2024', '57014'].includes(String((error as any)?.code)) ||
            /statement timeout|canceling statement/.test(String((error as any)?.message)))
        ) {
          await analysisTransaction(tx =>
            tx.$executeRawUnsafe(
              `UPDATE liekan_analysis_query SET status='queued',attempts=greatest(0,attempts-1),
             started_at=NULL,next_attempt_at=clock_timestamp(),error_code='analysis-fast-deferred',
             lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
             WHERE id=$1::uuid AND lease_token=$2::uuid AND status='running'`,
              row.id,
              row.lease_token,
            ),
          );
          return error instanceof Error ? error : new Error('analysis-fast-deferred');
        }
        await analysisTransaction(async tx => {
          await tx.$executeRawUnsafe(
            `UPDATE liekan_analysis_query SET status=CASE WHEN $3=410 OR $3 IN(401,403,404) THEN 'invalidated'
       WHEN attempts>=4 OR $3 IN(400,413) THEN 'failed' ELSE 'queued' END,error_code=$4,
       next_attempt_at=clock_timestamp()+(CASE attempts WHEN 1 THEN 5 WHEN 2 THEN 30 ELSE 120 END)*interval '1 second',
       lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1::uuid AND lease_token=$2::uuid`,
            row.id,
            row.lease_token,
            status,
            code,
          );
          await preserveDashboardFailure(tx, row.id);
          await pauseIdleDashboardRetries(tx);
        });
      } catch (recoveryError) {
        recoveryFailed = true;
        throw recoveryError;
      }
      return error instanceof Error ? error : new Error('analysis-compute-failed');
    } finally {
      diagnostics.finish(failure, recoveryFailed);
    }
  });
  // Candidate/head and claim races leave eligible foreground demand on the same bounded delivery.
  if (!result.acquired || !claimed)
    return {
      acquired: false as const,
      value: undefined,
      retryDelivery: await foregroundDeliveryPending(id),
    };
  return { ...result, retryDelivery: false, wakeDashboardHead: policy.lane === 'dashboard' };
}

/** A contended delivery yields its queue priority while durable computation retries keep their limits. */
export async function processAnalysisQueryDelivery(
  job: JobAttempt & { data: { id: string }; retryLimit?: number },
  boss: Pick<PgBoss, 'fail' | 'update' | 'send'>,
) {
  const result = await processAnalysisQuery(job.data.id);
  noteAnalysisDelivery(job, result.acquired, result.retryDelivery);
  if ('retryDelivery' in result && result.retryDelivery) {
    const failed = await boss.fail(ANALYSIS_QUERY_QUEUE, job, new Error('analysis-permit-busy'));
    if ('affected' in failed && failed.affected === 1)
      await boss.update(ANALYSIS_QUERY_QUEUE, undefined, { id: job.id, priority: 0 });
  }
  if (result.acquired && result.wakeDashboardHead && result.value === undefined) {
    try {
      const [head] = await analysisTransaction(tx =>
        tx.$queryRawUnsafe<Row[]>(
          `SELECT q.*,true AS foreground FROM liekan_analysis_query q
           WHERE q.status='queued' AND q.next_attempt_at<=clock_timestamp()
           AND q.retention_until>clock_timestamp()
           AND ${dashboardAnalysisWorkSql} AND ${dashboardRunnableHeadSql}
           ORDER BY q.queued_at,q.sequence LIMIT 1`,
        ),
      );
      if (head) await handoff(head, boss);
    } catch {
      // A completed computation stays published; the recovery pump retains the pending head.
    }
  }
}
