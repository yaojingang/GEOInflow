import { currentAnalysisPermit } from './analysis-permit-context';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fromPrisma, type PgBoss } from 'pg-boss';
import { formatInTimeZone } from 'date-fns-tz';
import prisma, { getRawQueryClient } from '@/lib/prisma';
import type {
  GeoWeightResponse,
  GeoWeightSnapshotQuery,
  GeoWeightSnapshotResponse,
} from '../contracts/geo-weight';
import {
  GEO_SNAPSHOT_FORMAT,
  geoWeightSnapshotQuerySchema,
  geoWeightRecalculateSchema,
  geoWeightResponseSchema,
} from '../contracts/geo-weight';
import { GEO_ALGORITHM } from '../geo-weight/policy';
import { canonicalGeoTimezone, geoDateOffset, geoWindow } from '../geo-weight/window';
import { getQueue } from '../log-ingestion/queue';
import { aiExecutor, type AiTx } from './ai-db';
import { authorizeCrawler, type CrawlerActor } from './crawler-access';
import {
  calculateGeoWeight,
  GEO_SCOPE_HASH,
  GeoWeightLockBusy,
  parseGeoWeightQuery,
} from './geo-weight';
import { LiekanError } from './errors';
import { noteCacheResult } from './cache-context';
import { warehouseEnabled } from '../warehouse/runtime';
import type { ReadBoundary } from '../warehouse/read';

export const GEO_SNAPSHOT_QUEUE = 'liekan-geo-weight-snapshot';
export const GEO_SNAPSHOT_LIMITS = Object.freeze({
  pending: 20,
  heads: 500,
  snapshots: 500,
  bytes: 64 * 1024 * 1024,
  resultBytes: 512 * 1024,
  leaseSeconds: 90,
  cooldownSeconds: 300,
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Tx = AiTx & { raw: any };
type Head = Record<string, any>;
type Snapshot = Record<string, any>;
export type GeoSnapshotJob = { headId: string; leaseEpoch?: number };

/** The queue adapter receives the very same primary transaction as demand registration. */
async function transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new LiekanError('数据库设置无效', 503);
  const client: any = getRawQueryClient(prisma.client, { write: true });
  return client.$transaction(
    async (raw: any) => {
      await raw.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await raw.$executeRawUnsafe("SET LOCAL statement_timeout TO '8000ms'");
      return work({ ...aiExecutor(raw), raw });
    },
    { timeout: 10000, maxWait: 1000 },
  );
}
function normalizedHostname(domain: string) {
  try {
    return new URL(/^https?:\/\//.test(domain) ? domain : `https://${domain}`).hostname
      .toLowerCase()
      .replace(/\.$/, '');
  } catch {
    throw new LiekanError('网站域名无效', 400);
  }
}
export function parseGeoSnapshotQuery(
  input: unknown,
  now = Date.now(),
): GeoWeightSnapshotQuery & { asOf: string } {
  const parsed = geoWeightSnapshotQuerySchema.safeParse(input);
  if (!parsed.success) throw new LiekanError('GEO 快照参数无效', 400);
  const p = { ...parsed.data, timezone: canonicalGeoTimezone(parsed.data.timezone) };
  if (/^[+-]/.test(p.timezone)) throw new LiekanError('GEO 权重需要有效的命名时区', 400);
  let asOf: string;
  try {
    asOf =
      p.mode === 'current' && !(p.taskId && p.asOf)
        ? geoDateOffset(formatInTimeZone(now, p.timezone, 'yyyy-MM-dd'), -1)
        : p.asOf;
  } catch {
    throw new LiekanError('GEO 权重需要有效时区和已结束的日期', 400);
  }
  parseGeoWeightQuery({ asOf, timezone: p.timezone, view: p.view }, now);
  if (!p.taskId && p.mode === 'current' && p.asOf && p.asOf !== asOf)
    throw new LiekanError('当前快照日期由服务器确定', 400);
  return { ...p, asOf };
}
/** Lightweight strong boundary: ordinary ingestion/data revisions and display names are excluded. */
export async function geoSnapshotAccess(
  tx: AiTx,
  actor: CrawlerActor,
  websiteId: string,
  timezone: string,
  asOf: string,
) {
  const website = await authorizeCrawler(tx, actor, websiteId);
  const [setting] = await tx.query(
    'SELECT ai_crawler_enabled FROM liekan_setting WHERE website_id=$1::uuid',
    websiteId,
  );
  if (setting?.ai_crawler_enabled === false) throw new LiekanError('AI 蜘蛛数据展示已关闭', 403);
  const [state] = await tx.query(
    'SELECT epoch,data_revision::text FROM liekan_log_state WHERE website_id=$1::uuid',
    websiteId,
  );
  const earliest = geoWindow(geoDateOffset(asOf, -30), timezone);
  const window = geoWindow(asOf, timezone);
  const [proof] = await tx.query(
    `SELECT coalesce(max(revision),0)::text AS revision FROM liekan_geo_weight_evidence_revision
    WHERE website_id=$1::uuid AND starts_at<$3::timestamptz AND ends_at>$2::timestamptz`,
    websiteId,
    new Date(earliest.startAt),
    new Date(window.endAt),
  );
  const boundary = {
    hostname: normalizedHostname(website.domain),
    epoch: state?.epoch || 1,
    resetAt: website.resetAt?.toISOString() || null,
    algorithm: GEO_ALGORITHM,
    scopeHash: GEO_SCOPE_HASH,
    evidenceRevision: proof?.revision || '0',
    ...(warehouseEnabled() ? { warehouse: (await tx.query(
      'SELECT epoch::text,deletion_revision::text FROM liekan_warehouse_site WHERE website_id=$1::uuid AND state=\'active\'', websiteId,
    ))[0] ?? null } : {}),
  };
  return {
    ...boundary,
    strongVersion: digest(boundary),
    ownership: digest([website.ownerUserId, website.teamId]),
    dataRevision: state?.data_revision || '0',
    canRecalculate: website.canControl,
    canManageCatalog: website.role === 'admin',
  };
}
function project(
  snapshot: Snapshot,
  access: Awaited<ReturnType<typeof geoSnapshotAccess>>,
  view: 'summary' | 'detail',
): GeoWeightResponse {
  const result = geoWeightResponseSchema.parse({
    ...snapshot.result,
    snapshotId: snapshot.id,
    canManageCatalog: access.canManageCatalog,
  }) as GeoWeightResponse;
  if (view === 'detail') return { ...result, view };
  const {
    previous: _previous,
    observations: _observations,
    comparison: _comparison,
    ...summary
  } = result;
  return { ...summary, view };
}
function envelope(
  p: ReturnType<typeof parseGeoSnapshotQuery>,
  access: Awaited<ReturnType<typeof geoSnapshotAccess>>,
  head?: Head,
  snapshot?: Snapshot,
): GeoWeightSnapshotResponse {
  return {
    format: GEO_SNAPSHOT_FORMAT,
    taskId: head?.id || null,
    taskStatus: head?.task_status || (snapshot ? 'ready' : 'queued'),
    result: snapshot ? project(snapshot, access, p.view) : null,
    snapshotId: snapshot?.id || null,
    requestedAsOf: p.asOf,
    servedAsOf: snapshot?.as_of || null,
    stale: !!snapshot && snapshot.as_of !== p.asOf,
    nextRetryAt: head?.next_retry_at ? new Date(head.next_retry_at).toISOString() : null,
    errorCode: head?.error_code || null,
    canRecalculate: access.canRecalculate,
    strongVersion: access.strongVersion,
  };
}
const snapshotSelect = `SELECT *,as_of::text AS as_of FROM liekan_geo_weight_snapshot`;
async function findHead(
  tx: AiTx,
  websiteId: string,
  p: ReturnType<typeof parseGeoSnapshotQuery>,
  access: Awaited<ReturnType<typeof geoSnapshotAccess>>,
) {
  const [head] = await tx.query(
    `SELECT *,as_of::text AS as_of FROM liekan_geo_weight_head WHERE website_id=$1::uuid AND hostname=$2 AND timezone=$3 AND as_of=$4::date AND epoch=$5 AND algorithm=$6 AND scope_hash=$7 AND strong_version=$8`,
    websiteId,
    access.hostname,
    p.timezone,
    p.asOf,
    access.epoch,
    GEO_ALGORITHM,
    GEO_SCOPE_HASH,
    access.strongVersion,
  );
  return head;
}
async function exactSnapshot(
  tx: AiTx,
  actor: CrawlerActor,
  websiteId: string,
  snapshotId: string,
  p?: ReturnType<typeof parseGeoSnapshotQuery>,
  exporting = false,
) {
  const [snapshot] = await tx.query(
    `${snapshotSelect} WHERE id=$1::uuid AND website_id=$2::uuid AND expires_at>now()`,
    snapshotId,
    websiteId,
  );
  if (!snapshot) throw new LiekanError('GEO 快照已淘汰，请重新读取', 410);
  if (
    p &&
    (p.timezone !== canonicalGeoTimezone(snapshot.timezone) ||
      (p.mode === 'historical' && p.asOf !== snapshot.as_of))
  )
    throw new LiekanError('GEO 快照口径不一致，请重新读取', 409);
  const access = await geoSnapshotAccess(tx, actor, websiteId, snapshot.timezone, snapshot.as_of);
  if (
    snapshot.strong_version !== access.strongVersion ||
    snapshot.epoch !== access.epoch ||
    snapshot.hostname !== access.hostname ||
    snapshot.algorithm !== GEO_ALGORITHM ||
    snapshot.scope_hash !== GEO_SCOPE_HASH
  )
    throw new LiekanError('GEO 快照基准已变化，请重新读取', 409);
  await tx.execute(
    `UPDATE liekan_geo_weight_snapshot SET last_read_at=now()${exporting ? ",export_until=greatest(coalesce(export_until,now()),now()+interval '60 seconds')" : ''} WHERE id=$1::uuid`,
    snapshot.id,
  );
  if (warehouseEnabled() && exporting) await tx.execute(`UPDATE liekan_warehouse_reference r SET expires_at=greatest(s.expires_at,s.export_until)
    FROM liekan_geo_weight_snapshot s WHERE r.kind='geo' AND r.owner_id=s.id AND s.id=$1::uuid`, snapshot.id);
  return { snapshot, access };
}
async function inspect(
  actor: CrawlerActor,
  websiteId: string,
  p: ReturnType<typeof parseGeoSnapshotQuery>,
) {
  return transaction(async tx => {
    let scope = p;
    let head: Head;
    if (p.taskId) {
      await authorizeCrawler(tx, actor, websiteId);
      [head] = await tx.query(
        'SELECT *,as_of::text AS as_of FROM liekan_geo_weight_head WHERE id=$1::uuid',
        p.taskId,
      );
      if (!head) throw new LiekanError('GEO 快照已淘汰，请重新读取', 410);
      if (head.website_id !== websiteId.toLowerCase())
        throw new LiekanError('当前网站不可访问', 404);
      if (
        canonicalGeoTimezone(head.timezone) !== p.timezone ||
        (p.mode === 'historical' && head.as_of !== p.asOf)
      )
        throw new LiekanError('GEO 快照口径不一致，请重新读取', 409);
      scope = { ...p, asOf: head.as_of };
    }
    const access = await geoSnapshotAccess(tx, actor, websiteId, scope.timezone, scope.asOf);
    if (p.taskId) {
      if (
        head.strong_version !== access.strongVersion ||
        head.hostname !== access.hostname ||
        head.epoch !== access.epoch ||
        head.algorithm !== GEO_ALGORITHM ||
        head.scope_hash !== GEO_SCOPE_HASH
      )
        throw new LiekanError('GEO 快照基准已变化，请重新读取', 409);
    } else head = await findHead(tx, websiteId, scope, access);
    if (p.snapshotId) {
      const exact = await exactSnapshot(tx, actor, websiteId, p.snapshotId, scope);
      return {
        requestedAsOf: scope.asOf,
        access,
        head: { ...head, task_status: 'ready', error_code: null, next_retry_at: null },
        snapshot: exact.snapshot,
      };
    }
    let snapshot: Snapshot;
    if (head?.snapshot_id) {
      const [found] = await tx.query(
        `${snapshotSelect} WHERE id=$1::uuid AND expires_at>now()`,
        head.snapshot_id,
      );
      if (found) snapshot = found;
    }
    if (!snapshot && scope.mode === 'current') {
      const candidates = await tx.query(
        `${snapshotSelect} WHERE website_id=$1::uuid AND hostname=$2 AND timezone=$3 AND epoch=$4 AND algorithm=$5 AND scope_hash=$6 AND as_of BETWEEN $7::date-7 AND $7::date AND expires_at>now() ORDER BY liekan_geo_weight_snapshot.as_of DESC,generation DESC LIMIT 8`,
        websiteId,
        access.hostname,
        scope.timezone,
        access.epoch,
        GEO_ALGORITHM,
        GEO_SCOPE_HASH,
        scope.asOf,
      );
      for (const candidate of candidates) {
        const oldAccess = await geoSnapshotAccess(
          tx,
          actor,
          websiteId,
          scope.timezone,
          candidate.as_of,
        );
        if (candidate.strong_version === oldAccess.strongVersion) {
          snapshot = candidate;
          break;
        }
      }
    }
    if (head)
      await tx.execute(
        'UPDATE liekan_geo_weight_head SET last_read_at=now() WHERE id=$1::uuid',
        head.id,
      );
    if (snapshot)
      await tx.execute(
        'UPDATE liekan_geo_weight_snapshot SET last_read_at=now() WHERE id=$1::uuid',
        snapshot.id,
      );
    return { requestedAsOf: scope.asOf, access, head, snapshot };
  });
}
async function siteLock(tx: AiTx, websiteId: string) {
  await tx.query(
    'SELECT true AS acquired FROM pg_advisory_xact_lock(hashtextextended($1,12800032))',
    websiteId,
  );
}
/** Lock every available referencing head before a snapshot's FK cleanup can touch it. */
async function lockEvictionCandidates(tx: AiTx, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const heads = await tx.query(
    'SELECT id FROM liekan_geo_weight_head WHERE snapshot_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE SKIP LOCKED',
    ids,
  );
  const snapshots = await tx.query(
    `SELECT s.id FROM liekan_geo_weight_snapshot s WHERE s.id=ANY($1::uuid[])
    AND (s.export_until IS NULL OR s.export_until<=now())
    AND NOT EXISTS(SELECT 1 FROM liekan_geo_weight_head h WHERE h.snapshot_id=s.id
      AND (h.id<>ALL($2::uuid[]) OR h.task_status IN ('queued','running')))
    FOR UPDATE OF s SKIP LOCKED`,
    ids,
    heads.map(head => head.id),
  );
  return new Set<string>(snapshots.map(snapshot => snapshot.id));
}
async function expireSnapshots() {
  const websites = await transaction(tx =>
    tx.query(
      `SELECT s.website_id FROM liekan_geo_weight_snapshot s
      WHERE s.expires_at<=now() AND (s.export_until IS NULL OR s.export_until<=now())
      AND (NOT EXISTS(SELECT 1 FROM website w WHERE w.website_id=s.website_id)
        OR NOT EXISTS(SELECT 1 FROM liekan_geo_weight_head h WHERE h.snapshot_id=s.id AND h.task_status IN ('queued','running')))
      GROUP BY s.website_id ORDER BY min(s.expires_at),s.website_id LIMIT 20`,
    ),
  );
  for (const { website_id: websiteId } of websites) {
    await transaction(async tx => {
      const [website] = await tx.query(
        'SELECT website_id FROM website WHERE website_id=$1::uuid FOR SHARE SKIP LOCKED',
        websiteId,
      );
      if (!website) {
        const [existing] = await tx.query(
          'SELECT EXISTS(SELECT 1 FROM website WHERE website_id=$1::uuid) AS present',
          websiteId,
        );
        if (existing.present) return;
      }
      const [lock] = await tx.query(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1,12800032)) AS acquired',
        websiteId,
      );
      if (!lock.acquired) return;
      if (!website)
        await tx.execute('DELETE FROM liekan_geo_weight_head WHERE website_id=$1::uuid', websiteId);
      const candidates = await tx.query(
        `SELECT s.id FROM liekan_geo_weight_snapshot s WHERE s.website_id=$1::uuid AND s.expires_at<=now()
        AND (s.export_until IS NULL OR s.export_until<=now())
        AND NOT EXISTS(SELECT 1 FROM liekan_geo_weight_head h WHERE h.snapshot_id=s.id AND h.task_status IN ('queued','running'))
        ORDER BY s.expires_at,s.id LIMIT 100`,
        websiteId,
      );
      const ids = await lockEvictionCandidates(
        tx,
        candidates.map(row => row.id),
      );
      if (ids.size)
        await tx.execute('DELETE FROM liekan_geo_weight_snapshot WHERE id=ANY($1::uuid[])', [
          ...ids,
        ]);
      if (warehouseEnabled() && ids.size) await tx.execute("DELETE FROM liekan_warehouse_reference WHERE kind='geo' AND owner_id=ANY($1::uuid[])", [...ids]);
    });
  }
}
/** Protect current days in every timezone, active demand and bounded exports during LRU eviction. */
async function prune(tx: AiTx, websiteId: string, reserveBytes = 0) {
  await tx.execute(
    `DELETE FROM liekan_geo_weight_evidence_revision r WHERE r.website_id=$1::uuid AND r.created_at<now()-interval '90 days' AND NOT EXISTS(SELECT 1 FROM liekan_geo_weight_snapshot s WHERE s.website_id=r.website_id AND s.expires_at>now() AND to_timestamp((s.input_boundary->'window'->>'startAt')::double precision/1000)<r.ends_at AND to_timestamp((s.input_boundary->'window'->>'endAt')::double precision/1000)>r.starts_at) AND NOT EXISTS(SELECT 1 FROM liekan_geo_weight_head h WHERE h.website_id=r.website_id AND h.task_status IN ('queued','running'))`,
    websiteId,
  );
  await tx.execute(
    `DELETE FROM liekan_geo_weight_request WHERE website_id=$1::uuid AND created_at<now()-interval '90 days'`,
    websiteId,
  );
  await tx.execute(
    `DELETE FROM liekan_geo_weight_head WHERE website_id=$1::uuid AND task_status NOT IN ('queued','running') AND last_read_at<now()-interval '90 days' AND NOT EXISTS(SELECT 1 FROM liekan_geo_weight_request r WHERE r.head_id=liekan_geo_weight_head.id AND r.created_at>=now()-interval '90 days')`,
    websiteId,
  );
  if (warehouseEnabled()) return true;
  const candidates = await tx.query(
    `SELECT s.id,s.result_bytes FROM liekan_geo_weight_snapshot s WHERE s.website_id=$1::uuid
    AND (s.export_until IS NULL OR s.export_until<now())
    AND s.as_of < (now() AT TIME ZONE s.timezone)::date-1
    AND NOT EXISTS(SELECT 1 FROM liekan_geo_weight_head h WHERE h.snapshot_id=s.id AND h.task_status IN ('queued','running')) ORDER BY s.last_read_at,s.id LIMIT 500`,
    websiteId,
  );
  const [usage] = await tx.query(
    `SELECT count(*)::int AS count,coalesce(sum(result_bytes),0)::text AS bytes FROM liekan_geo_weight_snapshot WHERE website_id=$1::uuid`,
    websiteId,
  );
  let count = usage.count,
    bytes = Number(usage.bytes);
  const evictable =
    count >= GEO_SNAPSHOT_LIMITS.snapshots || bytes + reserveBytes > GEO_SNAPSHOT_LIMITS.bytes
      ? await lockEvictionCandidates(
          tx,
          candidates.map(row => row.id),
        )
      : new Set<string>();
  for (const row of candidates) {
    if (count < GEO_SNAPSHOT_LIMITS.snapshots && bytes + reserveBytes <= GEO_SNAPSHOT_LIMITS.bytes)
      break;
    if (!evictable.has(row.id)) continue;
    await tx.execute('DELETE FROM liekan_geo_weight_snapshot WHERE id=$1::uuid', row.id);
    count--;
    bytes -= row.result_bytes;
  }
  await tx.execute(
    `DELETE FROM liekan_geo_weight_head WHERE id IN (SELECT id FROM liekan_geo_weight_head WHERE website_id=$1::uuid AND task_status NOT IN ('queued','running') AND snapshot_id IS NULL AND NOT EXISTS(SELECT 1 FROM liekan_geo_weight_request r WHERE r.head_id=liekan_geo_weight_head.id AND r.created_at>=now()-interval '90 days') ORDER BY last_read_at LIMIT greatest(0,(SELECT count(*)::int-499 FROM liekan_geo_weight_head WHERE website_id=$1::uuid)))`,
    websiteId,
  );
  return count < GEO_SNAPSHOT_LIMITS.snapshots && bytes + reserveBytes <= GEO_SNAPSHOT_LIMITS.bytes;
}
async function send(tx: Tx, boss: PgBoss, headId: string, startAfter?: Date) {
  const id = randomUUID();
  const sent = await boss.send(
    GEO_SNAPSHOT_QUEUE,
    { headId },
    {
      id,
      db: fromPrisma(tx.raw),
      retryLimit: 0,
      expireInSeconds: 120,
      retentionSeconds: 86400,
      ...(startAfter ? { startAfter } : {}),
    },
  );
  if (!sent) throw new LiekanError('GEO 后台队列未就绪，请稍后重新读取', 503);
  await tx.execute(
    'UPDATE liekan_geo_weight_head SET job_id=$2::uuid WHERE id=$1::uuid',
    headId,
    id,
  );
}
async function register(
  actor: CrawlerActor,
  websiteId: string,
  p: ReturnType<typeof parseGeoSnapshotQuery>,
  manual?: { requestId: string },
) {
  const boss = await getQueue();
  return transaction(async tx => {
    const access = await geoSnapshotAccess(tx, actor, websiteId, p.timezone, p.asOf);
    if (manual) await authorizeCrawler(tx, actor, websiteId, 'control');
    await siteLock(tx, websiteId);
    const parameterHash = digest([p.mode, p.asOf, p.timezone, GEO_ALGORITHM]);
    if (manual) {
      await tx.execute(
        "DELETE FROM liekan_geo_weight_request WHERE website_id=$1::uuid AND created_at<now()-interval '90 days'",
        websiteId,
      );
      const [receipt] = await tx.query(
        'SELECT parameter_hash,head_id FROM liekan_geo_weight_request WHERE website_id=$1::uuid AND actor_id=$2::uuid AND request_id=$3::uuid',
        websiteId,
        actor.id,
        manual.requestId,
      );
      if (receipt) {
        const [savedHead] = await tx.query(
          'SELECT timezone FROM liekan_geo_weight_head WHERE id=$1::uuid AND website_id=$2::uuid',
          receipt.head_id,
          websiteId,
        );
        const originalTimezone = savedHead?.timezone;
        if (
          receipt.parameter_hash !== parameterHash &&
          (!originalTimezone ||
            canonicalGeoTimezone(originalTimezone) !== p.timezone ||
            receipt.parameter_hash !== digest([p.mode, p.asOf, originalTimezone, GEO_ALGORITHM]))
        )
          throw new LiekanError('重算请求 ID 已用于其他口径', 409);
        const original = originalTimezone
          ? await findHead(tx, websiteId, { ...p, timezone: originalTimezone }, access)
          : undefined;
        if (!original || original.id !== receipt.head_id || original.ownership !== access.ownership)
          throw new LiekanError('GEO 快照基准已变化，请重新读取', 409);
        return original;
      }
    }
    let head = await findHead(tx, websiteId, p, access);
    if (!manual && head?.task_status === 'ready' && head.snapshot_id) {
      const [published] = await tx.query(
        'SELECT id FROM liekan_geo_weight_snapshot WHERE id=$1::uuid AND expires_at>now() AND strong_version=$2',
        head.snapshot_id,
        access.strongVersion,
      );
      if (published) return head;
    }
    const active = head && ['queued', 'running'].includes(head.task_status);
    if (manual && !active) {
      const [cooldown] = await tx.query(
        "SELECT max(manual_at)>now()-interval '5 minutes' AS blocked FROM liekan_geo_weight_head WHERE website_id=$1::uuid",
        websiteId,
      );
      if (cooldown?.blocked) throw new LiekanError('GEO 权重重算间隔为 5 分钟', 429);
    }
    if (
      !manual &&
      head &&
      head.error_code !== 'authority_or_boundary_changed' &&
      !(warehouseEnabled() && ['capacity_exhausted','result_too_large'].includes(head.error_code)) &&
      ((head.snapshot_id && head.task_status !== 'ready') ||
        ['failed', 'capacity_blocked'].includes(head.task_status))
    )
      return head;
    // Joining active demand preserves its initiator; manual callers still receive a receipt.
    if (!active) {
      const [pending] = await tx.query(
        "SELECT count(*)::int AS count FROM liekan_geo_weight_head WHERE website_id=$1::uuid AND task_status IN ('queued','running')",
        websiteId,
      );
      if (pending.count >= GEO_SNAPSHOT_LIMITS.pending)
        throw new LiekanError('GEO 待处理口径已达上限，请在 60 秒后重新读取', 429);
      const available = await prune(tx, websiteId);
      const [heads] = await tx.query(
        'SELECT count(*)::int AS count FROM liekan_geo_weight_head WHERE website_id=$1::uuid',
        websiteId,
      );
      if (!available || (!warehouseEnabled() && !head && heads.count >= GEO_SNAPSHOT_LIMITS.heads))
        return { task_status: 'capacity_blocked', error_code: 'capacity_exhausted' };
      if (head) {
        [head] = await tx.query(
          `UPDATE liekan_geo_weight_head SET task_status='queued',expected_generation=generation+1,actor_id=$2::uuid,ownership=$3,attempts=0,next_retry_at=NULL,error_code=NULL,queued_at=now(),completed_at=NULL,manual_at=CASE WHEN $4 THEN now() ELSE manual_at END WHERE id=$1::uuid RETURNING *`,
          head.id,
          actor.id,
          access.ownership,
          !!manual,
        );
      } else {
        [head] = await tx.query(
          `INSERT INTO liekan_geo_weight_head(website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,task_status,actor_id,ownership,manual_at) VALUES($1::uuid,$2,$3,$4::date,$5,$6,$7,$8,'queued',$9::uuid,$10,CASE WHEN $11 THEN now() ELSE NULL END) RETURNING *`,
          websiteId,
          access.hostname,
          p.timezone,
          p.asOf,
          access.epoch,
          GEO_ALGORITHM,
          GEO_SCOPE_HASH,
          access.strongVersion,
          actor.id,
          access.ownership,
          !!manual,
        );
      }
      await send(tx, boss, head.id);
    }
    if (manual) {
      const [count] = await tx.query(
        'SELECT count(*)::int AS count FROM liekan_geo_weight_request WHERE website_id=$1::uuid',
        websiteId,
      );
      if (!warehouseEnabled() && count.count >= 500)
        throw new LiekanError('GEO 待处理口径已达上限，请在 60 秒后重新读取', 429);
      await tx.execute(
        'INSERT INTO liekan_geo_weight_request(website_id,actor_id,request_id,parameter_hash,head_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid)',
        websiteId,
        actor.id,
        manual.requestId,
        parameterHash,
        head.id,
      );
    }
    return head;
  });
}
export async function readGeoWeightSnapshot(
  actor: CrawlerActor,
  websiteId: string,
  input: unknown,
  options: { signal?: AbortSignal; statusOnly?: boolean } = {},
): Promise<GeoWeightSnapshotResponse> {
  if (options.signal?.aborted) throw new LiekanError('统计读取已取消', 499);
  const p = parseGeoSnapshotQuery(input);
  let state = await inspect(actor, websiteId, p);
  if (
    !p.snapshotId &&
    !p.taskId &&
    !options.statusOnly &&
    (!state.head ||
      (state.head.task_status === 'ready' &&
        (!state.snapshot || state.snapshot.as_of !== p.asOf)) ||
      (warehouseEnabled() && ['capacity_exhausted','result_too_large'].includes(state.head.error_code)) ||
      state.head.error_code === 'authority_or_boundary_changed')
  ) {
    const head = await register(actor, websiteId, p);
    state =
      head.task_status === 'capacity_blocked'
        ? { ...state, head }
        : await inspect(actor, websiteId, p);
  }
  if (options.signal?.aborted) throw new LiekanError('统计读取已取消', 499);
  const response = envelope(
    { ...p, asOf: state.requestedAsOf },
    state.access,
    state.head,
    state.snapshot,
  );
  if (response.result) {
    const generatedAt = Date.parse(response.result.calculatedAt);
    noteCacheResult({
      value: response,
      generatedAt,
      expiresAt: Date.now() + 86400000,
      status: 'hit',
      tier: 'database' as any,
    });
  }
  return response;
}
export async function recalculateGeoWeight(actor: CrawlerActor, websiteId: string, input: unknown) {
  const parsed = geoWeightRecalculateSchema.safeParse(input);
  if (!parsed.success) throw new LiekanError('GEO 权重重算参数无效', 400);
  const { requestId, ...query } = parsed.data;
  const p = parseGeoSnapshotQuery({ ...query, view: 'detail' });
  const head = await register(actor, websiteId, p, { requestId });
  const state = await inspect(actor, websiteId, head.id ? { ...p, taskId: head.id } : p);
  return envelope(
    p,
    state.access,
    head.task_status === 'capacity_blocked' ? head : state.head,
    state.snapshot,
  );
}
export async function readLegacyGeoWeight(
  actor: CrawlerActor,
  websiteId: string,
  input: unknown,
  options: { signal?: AbortSignal; deadline?: number } = {},
) {
  const p = parseGeoWeightQuery(input);
  const query = { ...p, mode: 'historical' as const };
  const deadline = Math.min(options.deadline || Infinity, Date.now() + 5000);
  let state = await readGeoWeightSnapshot(actor, websiteId, query, { signal: options.signal });
  while (
    !state.result &&
    ['queued', 'running'].includes(state.taskStatus) &&
    Date.now() < deadline
  ) {
    await delay(Math.min(250, deadline - Date.now()), undefined, { signal: options.signal }).catch(
      () => {
        throw new LiekanError('统计读取已取消', 499);
      },
    );
    state = await readGeoWeightSnapshot(actor, websiteId, query, {
      signal: options.signal,
      statusOnly: true,
    });
  }
  if (!state.result) throw new LiekanError('GEO 权重计算未完成，请重新读取', 503);
  return state.result;
}
export async function readGeoWeightForExport(
  actor: CrawlerActor,
  websiteId: string,
  input: {
    snapshotId?: string;
    asOf?: string;
    timezone?: string;
    snapshot?: string;
    catalogVersion?: string;
  },
) {
  return transaction(async tx => {
    await authorizeCrawler(tx, actor, websiteId);
    let id = input.snapshotId;
    if (!id) {
      parseGeoWeightQuery({ asOf: input.asOf, timezone: input.timezone, view: 'detail' });
      const [saved] = await tx.query(
        `${snapshotSelect} WHERE website_id=$1::uuid AND as_of=$2::date AND timezone=$3 AND result_digest=$4 AND expires_at>now() ORDER BY generation DESC LIMIT 1`,
        websiteId,
        input.asOf,
        input.timezone,
        input.snapshot,
      );
      if (!saved || saved.result.readCatalogVersion !== input.catalogVersion)
        throw new LiekanError('GEO 权重快照不一致，请重新读取后导出', 409);
      id = saved.id;
    }
    const { snapshot, access } = await exactSnapshot(tx, actor, websiteId, id, undefined, true);
    return project(snapshot, access, 'detail');
  });
}

async function claim() {
  return transaction(async tx => {
    // Rotate websites by their last started calculation; each turn claims one identity.
    const [candidate] = await tx.query(`SELECT h.id,h.website_id FROM liekan_geo_weight_head h
      WHERE h.task_status='queued' AND (h.next_retry_at IS NULL OR h.next_retry_at<=now())
      AND NOT EXISTS(SELECT 1 FROM liekan_geo_weight_head r WHERE r.website_id=h.website_id AND r.task_status='running')
      ORDER BY coalesce((SELECT max(s.started_at) FROM liekan_geo_weight_head s WHERE s.website_id=h.website_id),'-infinity'::timestamptz),h.queued_at,h.id LIMIT 1 FOR UPDATE OF h SKIP LOCKED`);
    if (!candidate) return null;
    const [locked] = await tx.query(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1,12800032)) AS acquired',
      candidate.website_id,
    );
    if (!locked?.acquired) return null;
    const [head] = await tx.query(
      `UPDATE liekan_geo_weight_head SET task_status='running',lease_owner=$2::uuid,lease_epoch=lease_epoch+1,lease_until=now()+interval '90 seconds',attempts=attempts+1,started_at=now(),next_retry_at=NULL,error_code=NULL WHERE id=$1::uuid AND task_status='queued' AND NOT EXISTS(SELECT 1 FROM liekan_geo_weight_head other WHERE other.website_id=liekan_geo_weight_head.website_id AND other.task_status='running') RETURNING *,as_of::text AS as_of`,
      candidate.id,
      randomUUID(),
    );
    return head || null;
  });
}
function failureCode(error: unknown) {
  if (error instanceof LiekanError && [401, 403, 404, 409].includes(error.status))
    return 'authority_or_boundary_changed';
  if ((error as any)?.code === 'result_too_large') return 'result_too_large';
  if (error instanceof LiekanError && error.status === 429) return 'capacity_exhausted';
  if ((error as any)?.status === 499) return 'lease_lost';
  return 'calculation_unavailable';
}
async function failed(head: Head, error: unknown, boss: PgBoss) {
  await transaction(async tx => {
    const [current] = await tx.query(
      'SELECT * FROM liekan_geo_weight_head WHERE id=$1::uuid FOR UPDATE',
      head.id,
    );
    if (
      !current ||
      current.task_status !== 'running' ||
      current.lease_epoch !== head.lease_epoch ||
      current.lease_owner !== head.lease_owner
    )
      return;
    const busy = error instanceof GeoWeightLockBusy;
    const code = failureCode(error);
    const terminal =
      !busy &&
      (current.attempts >= 3 ||
        ['authority_or_boundary_changed', 'result_too_large', 'capacity_exhausted'].includes(code));
    const seconds = busy ? 5 : current.attempts === 1 ? 60 : 300;
    const retryAt = new Date(Date.now() + seconds * 1000);
    await tx.execute(
      `UPDATE liekan_geo_weight_head SET task_status=$2,lease_owner=NULL,lease_until=NULL,attempts=attempts-$3,next_retry_at=$4,error_code=$5,completed_at=CASE WHEN $6 THEN now() ELSE completed_at END WHERE id=$1::uuid`,
      head.id,
      terminal ? (code === 'capacity_exhausted' ? 'capacity_blocked' : 'failed') : 'queued',
      busy ? 1 : 0,
      terminal ? null : retryAt,
      busy ? null : code,
      terminal,
    );
    if (!terminal) await send(tx, boss, head.id, retryAt);
  });
}
export async function processGeoSnapshotJob(_job: GeoSnapshotJob, boss: PgBoss) {
  const head = await claim();
  if (!head) return;
  const actor = { id: head.actor_id, role: '' };
  const abort = new AbortController();
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void transaction(tx =>
      tx.execute(
        `UPDATE liekan_geo_weight_head SET lease_until=now()+interval '90 seconds' WHERE id=$1::uuid AND task_status='running' AND lease_owner=$2::uuid AND lease_epoch=$3 AND lease_until>now()`,
        head.id,
        head.lease_owner,
        head.lease_epoch,
      ),
    )
      .then(changed => {
        if (!changed) abort.abort();
      })
      .catch(() => abort.abort())
      .finally(() => {
        renewing = false;
      });
  }, 15000);
  try {
    await transaction(async tx => {
      const access = await geoSnapshotAccess(tx, actor, head.website_id, head.timezone, head.as_of);
      if (access.ownership !== head.ownership || access.strongVersion !== head.strong_version)
        throw new LiekanError('GEO 权重任务权限或基准已变化', 409);
    });
    let warehouseBoundary: ReadBoundary | undefined;
    const result = await calculateGeoWeight(
      actor,
      head.website_id,
      { asOf: head.as_of, timezone: head.timezone, view: 'detail' },
      { fresh: true, signal: abort.signal, globalLock: true, onWarehouseBoundary: value => { warehouseBoundary = value; } },
    );
    if (abort.signal.aborted) throw new LiekanError('GEO 权重任务租约已失效', 499);
    const { canManageCatalog: _permission, snapshotId: _id, ...shared } = result;
    const bytes = Buffer.byteLength(JSON.stringify(shared));
    if (!warehouseEnabled() && bytes > GEO_SNAPSHOT_LIMITS.resultBytes)
      throw Object.assign(new Error('Result exceeds snapshot limit'), { code: 'result_too_large' });
    await transaction(async tx => {
      const permit=currentAnalysisPermit();
      if(permit && !(await tx.query(`SELECT id FROM liekan_analysis_background_lease WHERE id AND token=$1::uuid AND epoch=$2::bigint AND lease_until>clock_timestamp() FOR SHARE`,permit.token,permit.epoch)).length)
        throw new LiekanError('GEO 权重后台名额已失效',499);
      // Website lifecycle operations acquire this lock before touching GEO heads.
      await geoSnapshotAccess(tx, actor, head.website_id, head.timezone, head.as_of);
      await siteLock(tx, head.website_id);
      const [live] = await tx.query(
        'SELECT * FROM liekan_geo_weight_head WHERE id=$1::uuid FOR UPDATE',
        head.id,
      );
      if (
        !live ||
        live.task_status !== 'running' ||
        live.lease_owner !== head.lease_owner ||
        live.lease_epoch !== head.lease_epoch ||
        new Date(live.lease_until).getTime() <= Date.now() ||
        live.expected_generation !== head.expected_generation ||
        live.generation !== head.generation
      )
        throw new LiekanError('GEO 权重任务租约已失效', 499);
      const access = await geoSnapshotAccess(tx, actor, head.website_id, head.timezone, head.as_of);
      if (access.ownership !== head.ownership || access.strongVersion !== head.strong_version)
        throw new LiekanError('GEO 权重任务权限或基准已变化', 409);
      if (warehouseEnabled()) {
        const [boundary] = await tx.query('SELECT epoch::text,publication::text,deletion_revision::text,state FROM liekan_warehouse_site WHERE website_id=$1::uuid FOR SHARE', head.website_id);
        if (!warehouseBoundary || boundary?.state !== 'active' || boundary.epoch !== warehouseBoundary.epoch ||
          boundary.deletion_revision !== warehouseBoundary.deletionRevision || BigInt(boundary.publication) < BigInt(warehouseBoundary.publication))
          throw new LiekanError('GEO 权重数据边界已变化', 409);
      }
      if (!(await prune(tx, head.website_id, bytes)))
        throw new LiekanError('GEO 快照存储已达上限', 429);
      const id = randomUUID();
      await tx.execute(
        `INSERT INTO liekan_geo_weight_snapshot(id,website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,generation,input_boundary,calculated_at,result,result_bytes,result_digest) VALUES($1::uuid,$2::uuid,$3,$4,$5::date,$6,$7,$8,$9,$10,$11::jsonb,$12::timestamptz,$13::jsonb,$14,$15)`,
        id,
        head.website_id,
        head.hostname,
        head.timezone,
        head.as_of,
        head.epoch,
        head.algorithm,
        head.scope_hash,
        head.strong_version,
        head.expected_generation,
        JSON.stringify({
          ...(warehouseBoundary ? { warehouse: warehouseBoundary } : {}),
          dataRevision: result.dataRevision,
          readCatalogVersion: result.readCatalogVersion,
          readCatalogHash: result.readCatalogHash,
          epoch: head.epoch,
          window: {
            startAt: result.previous?.startAt || result.current.startAt,
            endAt: result.current.endAt,
          },
          catalogVersions: [
            ...new Set([
              result.readCatalogVersion,
              ...(result.observations || []).flatMap(p => p.catalogVersions),
              ...(result.previous?.catalogVersions || []),
            ]),
          ],
          sourceVersions: [
            ...new Set([
              ...(result.observations || []).flatMap(p => p.sources),
              ...(result.previous?.sources || []),
            ]),
          ],
          verificationVersions: [
            ...new Set([
              ...(result.observations || []).flatMap(p => p.verificationVersions || []),
              ...(result.previous?.verificationVersions || []),
            ]),
          ],
          classificationVersions: [
            ...new Set([
              ...(result.observations || []).flatMap(p => p.classificationVersions),
              ...(result.previous?.classificationVersions || []),
            ]),
          ],
        }),
        result.calculatedAt,
        JSON.stringify(shared),
        bytes,
        result.snapshot,
      );
      if (warehouseBoundary) await tx.execute(`INSERT INTO liekan_warehouse_reference(reference_id,website_id,epoch,publication,kind,owner_id,expires_at)
        SELECT $1::uuid,$2::uuid,$3::bigint,$4::bigint,'geo',$5::uuid,expires_at FROM liekan_geo_weight_snapshot WHERE id=$5::uuid`,
        randomUUID(),head.website_id,warehouseBoundary.epoch,warehouseBoundary.publication,id);
      const changed = await tx.execute(
        `UPDATE liekan_geo_weight_head SET snapshot_id=$2::uuid,generation=expected_generation,task_status='ready',lease_owner=NULL,lease_until=NULL,next_retry_at=NULL,error_code=NULL,completed_at=now() WHERE id=$1::uuid AND task_status='running' AND lease_owner=$3::uuid AND lease_epoch=$4 AND generation=$5 AND expected_generation=$6`,
        head.id,
        id,
        head.lease_owner,
        head.lease_epoch,
        head.generation,
        head.expected_generation,
      );
      if (changed !== 1) throw new LiekanError('GEO 权重发布代次已变化', 409);
    });
  } catch (error) {
    await failed(head, error, boss);
  } finally {
    clearInterval(heartbeat);
  }
}
/** Existing worker maintenance performs a bounded reconciliation every minute. */
export async function reconcileGeoSnapshots(boss: PgBoss) {
  await expireSnapshots();
  await transaction(async tx => {
    const rows = await tx.query(
      `SELECT h.* FROM liekan_geo_weight_head h LEFT JOIN liekan_jobs.job j ON j.id=h.job_id AND j.name=$1
      WHERE (h.task_status='running' AND h.lease_until<now()) OR
      (h.task_status='queued' AND (h.next_retry_at IS NULL OR h.next_retry_at<=now()) AND (j.id IS NULL OR j.state IN ('completed','cancelled','failed')))
      ORDER BY h.queued_at LIMIT 20 FOR UPDATE OF h SKIP LOCKED`,
      GEO_SNAPSHOT_QUEUE,
    );
    for (const head of rows) {
      if (head.task_status === 'running') {
        const terminal = head.attempts >= 3;
        const retryAt = new Date(Date.now() + (head.attempts === 1 ? 60 : 300) * 1000);
        await tx.execute(
          `UPDATE liekan_geo_weight_head SET task_status=$2,lease_epoch=lease_epoch+1,lease_owner=NULL,lease_until=NULL,next_retry_at=$3,error_code='worker_lease_expired',completed_at=CASE WHEN $4 THEN now() ELSE completed_at END WHERE id=$1::uuid`,
          head.id,
          terminal ? 'failed' : 'queued',
          terminal ? null : retryAt,
          terminal,
        );
        if (!terminal) await send(tx, boss, head.id, retryAt);
      } else await send(tx, boss, head.id);
    }
  });
}
