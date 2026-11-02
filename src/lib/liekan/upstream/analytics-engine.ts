import { createHash } from 'node:crypto';
import { ROLES } from '@/lib/constants';
import {
  type AnalyticsEngineStatus,
  analyticsEngineActionSchema,
} from '../contracts/analytics-engine';
import { CRAWLER_POPULATION_VERSION } from '../rules/population';
import { analysisTransaction, findAnalysisVersions } from './analysis-rollups-db';
import type { AnalysisTx } from './analysis-rollups-model';
import {
  ENGINE_VERSION,
  engineConnection,
  engineQuery,
  initializeEngineTable,
} from './analytics-engine-clickhouse';
import { authenticateCrawlerMaintenance } from './crawler-maintenance';
import { LiekanError } from './errors';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';

export const currentEngineVersionsSql = `(liekan_analysis_versions(s.website_id,'${ENGINE_VERSION}','${TRAFFIC_POLICY_VERSION}','${CRAWLER_POPULATION_VERSION}')
 || jsonb_build_object('siteEpoch',s.epoch::text,'siteRevision',s.revision::text))`;
export const validEngineUnitSql = `u.generation IS NOT NULL AND u.active_epoch=$1::bigint AND u.verified_at IS NOT NULL
 AND NOT s.purge_pending AND u.versions=${currentEngineVersionsSql}
 AND u.fingerprint=liekan_engine_fingerprint(u.website_id,u.bucket)`;
export async function engineAdmin(tx: AnalysisTx, actor: string) {
  const [user] = await tx.$queryRawUnsafe<any[]>(
    'SELECT role FROM "user" WHERE user_id=$1::uuid AND deleted_at IS NULL FOR SHARE',
    actor,
  );
  if (user?.role !== ROLES.admin)
    throw new LiekanError('此操作需要系统管理员完整登录', 403, 'engine-admin-required');
}
export async function engineVersions(tx: AnalysisTx, websiteId: string) {
  const base = await findAnalysisVersions(tx, websiteId);
  if (!base) return null;
  const [site] = await tx.$queryRawUnsafe<any[]>(
    'SELECT epoch,revision,purge_pending FROM liekan_analytics_engine_site WHERE website_id=$1::uuid',
    websiteId,
  );
  if (!site || site.purge_pending) return null;
  return {
    ...base,
    engine: ENGINE_VERSION,
    siteEpoch: String(site.epoch),
    siteRevision: String(site.revision),
  };
}
export async function engineStatus(actor: string, cursor?: string): Promise<AnalyticsEngineStatus> {
  return analysisTransaction(async tx => {
    await engineAdmin(tx, actor);
    const [state] = await tx.$queryRawUnsafe<any[]>(
      'SELECT * FROM liekan_analytics_engine WHERE id=1',
    );
    let config: ReturnType<typeof engineConnection> = null;
    try {
      config = engineConnection();
    } catch {
      /* Invalid deployment configuration stays unavailable. */
    }
    const sites = await tx.$queryRawUnsafe<any[]>(
      `WITH selected AS MATERIALIZED(SELECT s.*,w.name FROM liekan_analytics_engine_site s LEFT JOIN website w USING(website_id)
       WHERE ((w.website_id IS NOT NULL AND w.deleted_at IS NULL) OR s.purge_pending)
       AND ($2::uuid IS NULL OR s.website_id>$2::uuid) ORDER BY s.website_id LIMIT 11),
       current_sites AS MATERIALIZED(SELECT s.*,${currentEngineVersionsSql} AS current_versions FROM selected s)
       SELECT s.website_id AS "websiteId",s.name,
      count(u.bucket) FILTER(WHERE ${validEngineUnitSql.replace(currentEngineVersionsSql, 's.current_versions')})::text AS completed,
      (count(u.bucket) FILTER(WHERE NOT coalesce((${validEngineUnitSql.replace(currentEngineVersionsSql, 's.current_versions')}),false) OR u.candidate IS NOT NULL)+greatest(0,extract(epoch FROM least(s.history_end,clock_timestamp())-s.history_cursor)/3600)::bigint)::text AS pending,
      count(u.bucket) FILTER(WHERE u.error_code IS NOT NULL)::text AS failed,
      coalesce(sum(u.row_count),0)::text AS rows,min(u.bucket) AS "rangeStart",max(u.bucket)+interval '1 hour' AS "rangeEnd",
      max(u.published_at) AS "lastPublishedAt",s.purge_pending AS "purgePending"
      FROM current_sites s LEFT JOIN liekan_analytics_engine_unit u USING(website_id)
      GROUP BY s.website_id,s.name,s.purge_pending,s.history_end,s.history_cursor,s.current_versions ORDER BY s.website_id`,
      String(state.epoch),
      cursor || null,
    );
    const iso = (v: any) => (v ? new Date(v).toISOString() : null);
    return {
      configured: !!config,
      supported: !process.env.CLICKHOUSE_URL,
      connection: config?.label || null,
      enabled: state.enabled,
      syncing: state.syncing,
      revision: Number(state.revision),
      healthy: !!config && state.connection_hash === config.key && state.healthy,
      checkedAt: iso(state.checked_at),
      version: state.version,
      workerAt: iso(state.worker_at),
      error: state.error_code,
      nextCursor: sites.length > 10 ? sites[9].websiteId : null,
      sites: sites.slice(0, 10).map(s => ({
        ...s,
        name: s.name || s.websiteId,
        rangeStart: iso(s.rangeStart),
        rangeEnd: iso(s.rangeEnd),
        lastPublishedAt: iso(s.lastPublishedAt),
      })),
    };
  });
}
export async function getAnalyticsEngine(request: Request) {
  const cursor = new URL(request.url).searchParams.get('cursor') || undefined;
  if (
    cursor &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(cursor)
  )
    throw new LiekanError('分页游标无效', 400);
  return engineStatus((await authenticateCrawlerMaintenance(request)).id, cursor);
}
export async function changeAnalyticsEngine(request: Request, raw: unknown) {
  const actor = await authenticateCrawlerMaintenance(request);
  const parsed = analyticsEngineActionSchema.safeParse(raw);
  if (!parsed.success) throw new LiekanError('分析引擎操作参数无效', 400, 'engine-invalid-input');
  const input = parsed.data;
  const hash = createHash('sha256')
    .update(JSON.stringify({ ...input, actor: actor.id }))
    .digest('hex');
  await analysisTransaction(async tx => {
    await engineAdmin(tx, actor.id);
    const [state] = await tx.$queryRawUnsafe<any[]>(
      'SELECT * FROM liekan_analytics_engine WHERE id=1 FOR UPDATE',
    );
    const [previous] = await tx.$queryRawUnsafe<any[]>(
      'SELECT request_hash FROM liekan_analytics_engine_operation WHERE request_id=$1::uuid',
      input.requestId,
    );
    if (previous) {
      if (previous.request_hash !== hash)
        throw new LiekanError('请求标识已被使用', 409, 'engine-request-conflict');
      return;
    }
    if (String(state.revision) !== String(input.expectedRevision))
      throw new LiekanError('分析引擎状态已变化，请刷新', 409, 'engine-revision-conflict');
    let config: ReturnType<typeof engineConnection>;
    try {
      config = engineConnection();
    } catch {
      if (input.action !== 'disable')
        throw new LiekanError(
          '分析连接配置无效，请由部署管理员检查',
          409,
          'engine-invalid-connection',
        );
      config = null;
    }
    if (input.action !== 'disable' && !config)
      throw new LiekanError('请先完成 ClickHouse 部署配置', 409, 'engine-unconfigured');
    if (input.action === 'check') {
      if (state.connection_hash && state.connection_hash !== config.key) {
        const [pending] = await tx.$queryRawUnsafe<any[]>(
          `SELECT EXISTS(SELECT 1 FROM liekan_analytics_engine_site WHERE purge_pending)
           AND NOT EXISTS(SELECT 1 FROM liekan_analytics_engine_site WHERE purge_pending AND $1=ANY(pending_targets)) AS pending`,
          config.key,
        );
        if (pending.pending)
          throw new LiekanError(
            '请先完成原连接的数据清理，再更换分析连接',
            409,
            'engine-cleanup-pending',
          );
      }
      try {
        const [result] = await engineQuery('SELECT version() AS version');
        if (state.connection_hash && state.connection_hash !== config.key)
          await tx.$executeRawUnsafe(
            'UPDATE liekan_analytics_engine SET epoch=epoch+1,enabled=false,syncing=false WHERE id=1',
          );
        await tx.$executeRawUnsafe(
          `UPDATE liekan_analytics_engine SET checked_at=clock_timestamp(),healthy=true,version=$1,connection_hash=$2,error_code=NULL WHERE id=1`,
          result.version,
          config.key,
        );
      } catch {
        await tx.$executeRawUnsafe(
          "UPDATE liekan_analytics_engine SET checked_at=clock_timestamp(),healthy=false,error_code='engine-connection-failed' WHERE id=1",
        );
      }
    } else if (input.action === 'prepare') {
      if (!state.healthy || state.connection_hash !== config.key)
        throw new LiekanError('请先检查当前连接', 409, 'engine-check-required');
      await initializeEngineTable();
      // Fence transactions that began before capture was enabled.
      await tx.$executeRawUnsafe('LOCK TABLE liekan_log IN SHARE ROW EXCLUSIVE MODE');
      await tx.$executeRawUnsafe(`INSERT INTO liekan_analytics_engine_site(website_id,history_cursor,history_start,history_end)
        SELECT w.website_id,date_bin(interval '1 hour',coalesce(b.first,clock_timestamp()-interval '1 hour'),timestamptz '2000-01-01Z'),
        date_bin(interval '1 hour',coalesce(b.first,clock_timestamp()-interval '1 hour'),timestamptz '2000-01-01Z'),
        date_bin(interval '1 hour',coalesce(b.last,clock_timestamp()-interval '1 hour'),timestamptz '2000-01-01Z')+interval '1 hour'
        FROM website w CROSS JOIN LATERAL (SELECT
         (SELECT created_at FROM liekan_log WHERE website_id=w.website_id ORDER BY created_at LIMIT 1) AS first,
         (SELECT created_at FROM liekan_log WHERE website_id=w.website_id ORDER BY created_at DESC LIMIT 1) AS last) b
        WHERE w.deleted_at IS NULL ON CONFLICT(website_id) DO NOTHING`);
      await tx.$executeRawUnsafe(
        `UPDATE liekan_analytics_engine SET capture=true,syncing=true,actor_id=$1::uuid,locale=$2 WHERE id=1`,
        actor.id,
        input.locale,
      );
    } else if (input.action === 'verify') {
      await tx.$executeRawUnsafe('UPDATE liekan_analytics_engine_unit SET verified_at=NULL');
      await tx.$executeRawUnsafe(
        'UPDATE liekan_analytics_engine SET syncing=true,actor_id=$1::uuid,error_code=NULL WHERE id=1',
        actor.id,
      );
    } else if (input.action === 'enable') {
      const [ready] = await tx.$queryRawUnsafe<any[]>(
        `SELECT EXISTS(SELECT 1 FROM liekan_analytics_engine_unit u JOIN liekan_analytics_engine_site s USING(website_id) JOIN website w USING(website_id) WHERE w.deleted_at IS NULL AND ${validEngineUnitSql}) AS ready,
        EXISTS(SELECT 1 FROM liekan_analytics_engine_unit WHERE error_code IS NOT NULL) AS failed`,
        String(state.epoch),
      );
      if (
        !state.healthy ||
        state.connection_hash !== config.key ||
        !state.worker_at ||
        Date.now() - +new Date(state.worker_at) > 120000 ||
        !ready.ready ||
        ready.failed
      )
        throw new LiekanError('请先完成同步和对账，并检查后台状态', 409, 'engine-not-ready');
      await tx.$executeRawUnsafe(
        'UPDATE liekan_analytics_engine SET enabled=true,syncing=true,actor_id=$1::uuid WHERE id=1',
        actor.id,
      );
    } else if (input.action === 'disable' || input.action === 'pause') {
      await tx.$executeRawUnsafe(
        `UPDATE liekan_analytics_engine SET enabled=false,syncing=false WHERE id=1`,
      );
    } else {
      if (!state.capture || state.connection_hash !== config.key)
        throw new LiekanError('请先准备数据', 409, 'engine-prepare-required');
      await tx.$executeRawUnsafe(
        'UPDATE liekan_analytics_engine SET syncing=true,actor_id=$1::uuid,error_code=NULL WHERE id=1',
        actor.id,
      );
      await tx.$executeRawUnsafe(
        'UPDATE liekan_analytics_engine_unit SET attempts=0,error_code=NULL,retry_at=NULL',
      );
    }
    // One epoch fences reads, worker publications and persisted results after a routing change.
    await tx.$executeRawUnsafe(`UPDATE liekan_analytics_engine SET revision=revision+1 WHERE id=1`);
    if (['enable', 'disable', 'pause'].includes(input.action)) {
      await tx.$executeRawUnsafe(`INSERT INTO liekan_analytics_revision(resource_type,resource_id,revision)
        SELECT 'website',website_id,1 FROM website ON CONFLICT(resource_type,resource_id) DO UPDATE
        SET revision=liekan_analytics_revision.revision+1,updated_at=clock_timestamp()`);
    }
    await tx.$executeRawUnsafe(
      'INSERT INTO liekan_analytics_engine_operation(request_id,actor_id,request_hash,action,locale) VALUES($1::uuid,$2::uuid,$3,$4,$5)',
      input.requestId,
      actor.id,
      hash,
      input.action,
      input.locale,
    );
  });
  return engineStatus(actor.id);
}
