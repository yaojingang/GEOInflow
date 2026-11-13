import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logPublicOrigin } from '../contracts/installation';
import { healthSchema } from '../contracts/log-sources';
import { getPublishedCatalog } from '../crawlers/published';
import { applyTrustedEdgeIdentity } from '../crawlers/request-verification';
import { getSettings } from '../store';
import { withPublishedRegistry } from '../upstream/crawler-registry-context';
import { collectionRepairScope } from '../upstream/history-repair-boundary';
import { normalizeAutomaticWithGeography, persistLogGeography } from '../upstream/log-geography';
import { invalidateWebsiteAnalytics } from '../upstream/query-cache';
import {
  LiekanError,
  query,
  sourceWebsite,
  transaction,
  type WriteIdentity,
} from '../upstream/server';
import { prepareWarehouseUpload, sendWarehouseUpload } from '../upstream/warehouse-log-ingestion';
import { warehouseEnabled, warehouseIntakeEnabled } from '../warehouse/runtime';
import {
  prepareWarehouseCrawlerCoverage,
  type WarehouseCrawlerCoverage,
} from '../upstream/warehouse-crawler-coverage';
import {
  archiveCrawlerRules,
  crawlerClassificationVersion,
  persistCrawlerEvidence,
} from './crawler-evidence';
import { recordCrawlerCoverage } from './crawler-quality';
import { applyEdgeCapabilities } from './edge-observation';
import { samplingAtReceipt } from './measurement';
import {
  type AutomaticRecord,
  decodeUpload,
  hostname,
  normalizeAutomatic,
  stableUuid,
} from './protocol';
import { enqueue, LOG_QUEUE, PROVIDER_QUEUE } from './queue';
import { verificationSnapshots } from './ranges';
import { newToken, tokenHash } from './secrets';

export interface LogSource {
  id: string;
  website_id: string;
  kind: 'server' | 'cloudflare';
  domain: string;
  created_by: string;
  owner_id: string | null;
  team_id: string | null;
  state: 'configuring' | 'active' | 'paused' | 'disconnected' | 'error';
  credential_hash: string | null;
  credential_version: number;
  requested_policy_revision: bigint | number;
  provider_config: string | null;
  provider_job_id: string | null;
  health?: {
    fieldCapabilities?: Record<string, boolean>;
    measurement?: { version: string; observedAt: string; samplingRate: number };
  };
}
export const uuid = (id: string) => {
  if (!z.uuid().safeParse(id).success) throw new LiekanError('接入标识无效');
  return id.toLowerCase();
};
export function publicUrl() {
  const value = process.env.LIEKAN_PUBLIC_URL;
  if (!value) throw new LiekanError('尚未配置公网 HTTPS 接收地址', 503);
  const origin = logPublicOrigin(value);
  if (!origin) throw new LiekanError('公网地址需要可信 HTTPS 域名', 503);
  return origin;
}
export async function ensureState(tx: any, websiteId: string) {
  await tx.$executeRawUnsafe(
    'INSERT INTO liekan_log_state(website_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING',
    websiteId,
  );
  return (
    await tx.$queryRawUnsafe(
      'SELECT epoch,reset_at,policy_revision FROM liekan_log_state WHERE website_id=$1::uuid',
      websiteId,
    )
  )[0];
}
export async function validateSource(
  tx: any,
  id: string,
  token?: string,
  allowInactive = false,
  websiteLock: 'update' | 'share' = 'update',
) {
  const first: LogSource = (
    await tx.$queryRawUnsafe('SELECT * FROM liekan_log_source WHERE id=$1::uuid', uuid(id))
  )[0];
  if (!first || (token !== undefined && tokenHash(token) !== first.credential_hash))
    throw new LiekanError('接入凭据无效', 401);
  const website = await sourceWebsite(
    tx,
    first.website_id,
    { userId: first.created_by },
    websiteLock,
  );
  const source: LogSource = (
    await tx.$queryRawUnsafe(
      'SELECT * FROM liekan_log_source WHERE id=$1::uuid FOR UPDATE',
      first.id,
    )
  )[0];
  if (token !== undefined && tokenHash(token) !== source.credential_hash)
    throw new LiekanError('接入凭据已变更', 401);
  if (
    hostname(website.domain) !== source.domain ||
    website.user_id !== source.owner_id ||
    website.team_id !== source.team_id
  )
    throw new LiekanError('网站域名或归属已变更，请重新连接', 403);
  if (source.state === 'disconnected' || (!allowInactive && source.state !== 'active'))
    throw new LiekanError('日志来源已暂停', 409);
  const state = await ensureState(tx, source.website_id);
  return { source, epoch: state.epoch as number, resetAt: state.reset_at || website.reset_at };
}
export async function activateSource(tx: any, source: LogSource) {
  if (!source.credential_hash || (source.kind === 'cloudflare' && !source.provider_config))
    throw new LiekanError('接入凭据已失效，请重新连接', 409);
  const state = await ensureState(tx, source.website_id);
  if (String(state.policy_revision) !== String(source.requested_policy_revision))
    throw new LiekanError('主要来源已变更，请重新确认此连接', 409);
  const cutover = (await tx.$queryRawUnsafe('SELECT clock_timestamp() AS time'))[0].time;
  await tx.$executeRawUnsafe(
    'UPDATE liekan_log_interval SET ends_at=$2::timestamptz WHERE website_id=$1::uuid AND ends_at IS NULL',
    source.website_id,
    cutover,
  );
  await tx.$executeRawUnsafe(
    "UPDATE liekan_log_source SET state='paused' WHERE website_id=$1::uuid AND id!=$2::uuid AND state='active'",
    source.website_id,
    source.id,
  );
  await tx.$executeRawUnsafe(
    'INSERT INTO liekan_log_interval(id,website_id,source_id,starts_at) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::timestamptz)',
    randomUUID(),
    source.website_id,
    source.id,
    cutover,
  );
  await tx.$executeRawUnsafe(
    "UPDATE liekan_log_source SET state='active',error_code=NULL WHERE id=$1::uuid",
    source.id,
  );
  await tx.$executeRawUnsafe(
    'UPDATE liekan_log_state SET policy_revision=policy_revision+1,updated_at=now() WHERE website_id=$1::uuid',
    source.website_id,
  );
}
export async function createSource(
  tx: any,
  websiteId: string,
  kind: LogSource['kind'],
  identity: WriteIdentity,
) {
  const website = await sourceWebsite(tx, websiteId, identity);
  const state = await ensureState(tx, websiteId);
  const sourceId = randomUUID(),
    token = newToken();
  await tx.$executeRawUnsafe(
    'INSERT INTO liekan_log_source(id,website_id,kind,domain,created_by,owner_id,team_id,credential_hash,requested_policy_revision) VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::uuid,$7::uuid,$8,$9)',
    sourceId,
    websiteId,
    kind,
    hostname(website.domain),
    identity.userId,
    website.user_id,
    website.team_id,
    tokenHash(token),
    state.policy_revision,
  );
  const source: LogSource = (
    await tx.$queryRawUnsafe('SELECT * FROM liekan_log_source WHERE id=$1::uuid', sourceId)
  )[0];
  return { source, token };
}
export async function listSources(websiteId: string) {
  // The warehouse upload tracks published progress, while the ingest batch
  // also covers legacy uploads and is retained according to the log policy.
  return query(
    `SELECT s.id,s.kind,s.domain,s.state,s.credential_version AS "credentialVersion",s.last_heartbeat_at AS "lastHeartbeatAt",s.last_received_at AS "lastReceivedAt",s.last_processed_at AS "lastProcessedAt",s.last_test_at AS "lastTestAt",s.error_code AS "errorCode",s.health,
    (SELECT count(*)::int FROM liekan_ingest_batch b WHERE b.source_id=s.id AND b.state='pending') AS backlog,
    (SELECT count(*)::int FROM liekan_ingest_batch b WHERE b.source_id=s.id AND b.state='failed') AS failed,
    EXISTS(SELECT 1 FROM liekan_log_interval i WHERE i.source_id=s.id AND i.ends_at IS NULL) AS primary,
    (s.provider_config IS NOT NULL AND (s.state='disconnected' OR s.credential_hash IS NULL)) AS "cleanupPending",
    CASE WHEN latest.id IS NOT NULL THEN jsonb_build_object(
      'receivedAt',latest.received_at,
      'state',CASE
        WHEN latest.state IN ('failed','cancelled') THEN latest.state
        WHEN latest.state='processed' AND upload.inserted>0 THEN 'published'
        WHEN latest.state='processed' THEN 'processed'
        WHEN upload.processed>0 THEN 'processing'
        WHEN NOT upload.queued THEN 'registered'
        ELSE 'queued'
      END,
      'expected',latest.valid,
      'processed',coalesce(upload.processed,CASE WHEN latest.state='processed' THEN latest.valid ELSE 0 END),
      'inserted',latest.inserted,'conflicts',coalesce(upload.conflicts,0)
    ) END AS "latestBatch"
    FROM liekan_log_source s
    LEFT JOIN liekan_log_state log_state ON log_state.website_id=s.website_id
    LEFT JOIN LATERAL (
      SELECT b.id,b.received_at,b.state,b.valid,b.inserted FROM liekan_ingest_batch b
      WHERE b.website_id=s.website_id AND b.source_id=s.id AND b.epoch=coalesce(log_state.epoch,1)
      ORDER BY b.received_at DESC,b.id DESC LIMIT 1
    ) latest ON true
    LEFT JOIN liekan_warehouse_upload upload ON upload.batch_id=latest.id AND upload.website_id=s.website_id
    WHERE s.website_id=$1::uuid AND (s.state!='disconnected' OR s.provider_config IS NOT NULL) ORDER BY s.created_at DESC`,
    websiteId,
  );
}
export async function receiveBatch(request: Request, sourceId: string) {
  return withPublishedRegistry(() => receivePinnedBatch(request, sourceId));
}
async function receivePinnedBatch(request: Request, sourceId: string) {
  sourceId = uuid(sourceId);
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new LiekanError('需要来源凭据', 401);
  const principal = await transaction(tx => validateSource(tx, sourceId, token, true));
  const upload = await decodeUpload(request, principal.source.kind);
  if (upload.test) {
    if (principal.source.kind !== 'cloudflare') throw new LiekanError('连接测试无效');
    await transaction(async tx => {
      await validateSource(tx, sourceId, token, true);
      await tx.$executeRawUnsafe(
        'UPDATE liekan_log_source SET last_test_at=now() WHERE id=$1::uuid',
        sourceId,
      );
    });
    return { test: true };
  }
  const secret = process.env.APP_SECRET;
  if (!secret) throw new LiekanError('日志隐私服务未配置', 503);
  const settings = await getSettings(principal.source.website_id);
  const parsed = await normalizeAutomaticWithGeography(
    principal.source.kind,
    sourceId,
    upload.events,
    principal.source.domain,
    secret,
    settings.rules,
    await verificationSnapshots(),
    undefined,
    settings.crawlerRules,
  );
  const digest = createHmac('sha256', secret)
    .update(`${sourceId}:${upload.epoch}:${upload.digest}`)
    .digest('hex');
  const batchId = stableUuid(`${sourceId}:${upload.epoch}:${upload.batchId}`);
  const warehouse = warehouseIntakeEnabled();
  const response = await transaction(async tx => {
    const live = await validateSource(tx, sourceId, token);
    if (upload.epoch !== live.epoch) throw new LiekanError('采集代次已更新，请同步配置', 409);
    const [interval] = await tx.$queryRawUnsafe(
      'SELECT id FROM liekan_log_interval WHERE source_id=$1::uuid AND ends_at IS NULL ORDER BY starts_at DESC LIMIT 1',
      sourceId,
    );
    const observed = live.source.health?.measurement;
    const sampling = samplingAtReceipt(live.source.kind, observed);
    const configVersion = createHash('sha256')
      .update(
        JSON.stringify({
          sourceId,
          epoch: live.epoch,
          kind: live.source.kind,
          domain: live.source.domain,
          credentialVersion: live.source.credential_version,
          providerJobId: live.source.provider_job_id,
          measurement: observed?.version ?? null,
        }),
      )
      .digest('hex');
    for (const record of parsed.records)
      if (record.measurement) {
        record.measurement.sourceConfigVersion = configVersion;
        record.measurement.sourceIntervalVersion = interval ? `${sourceId}:${interval.id}` : null;
        Object.assign(record.measurement, sampling);
      }

    for (const record of parsed.records)
      if (record.crawlerEvidence?.edgeObservation)
        record.crawlerEvidence.edgeObservation = applyEdgeCapabilities(
          record.crawlerEvidence.edgeObservation,
          live.source.health?.fieldCapabilities,
        );
    if (principal.source.provider_job_id === live.source.provider_job_id)
      for (const record of parsed.records)
        applyTrustedEdgeIdentity(record, live.source, settings.crawlerRules);
    const old = (
      await tx.$queryRawUnsafe(
        'SELECT id,digest,valid,rejected,state,inserted,duplicates FROM liekan_ingest_batch WHERE id=$1::uuid',
        batchId,
      )
    )[0];
    const queueState = warehouse
      ? (
          await tx.$queryRawUnsafe(
            'SELECT queued FROM liekan_warehouse_upload WHERE batch_id=$1::uuid',
            batchId,
          )
        )[0]
      : undefined;
    if (old && warehouse && old.state === 'pending' && !queueState)
      throw new LiekanError('旧日志批次需要完成迁移后继续处理', 503);
    if (old && old.digest !== digest) throw new LiekanError('同一批次标识的内容已改变', 409);
    if (old && !(warehouse && queueState && !queueState.queued)) {
      if (old.digest !== digest) throw new LiekanError('同一批次标识的内容已改变', 409);
      return {
        requestBatchId: upload.batchId,
        epoch: live.epoch,
        batchId: old.id,
        received: upload.events.length,
        valid: old.valid,
        rejected: old.rejected,
        duplicate: true,
      };
    }
    const ledger = (
      await tx.$queryRawUnsafe(
        "SELECT id,digest FROM liekan_import WHERE id=$1::uuid AND source_id=$2::uuid AND kind='automatic'",
        batchId,
        sourceId,
      )
    )[0];
    if (ledger && !(warehouse && queueState && !queueState.queued)) {
      if (ledger.digest !== digest) throw new LiekanError('同一批次标识的内容已改变', 409);
      return {
        requestBatchId: upload.batchId,
        epoch: live.epoch,
        batchId,
        received: parsed.received,
        valid: parsed.records.length,
        rejected: parsed.rejected,
        duplicate: true,
      };
    }
    const effective = await getSettings(live.source.website_id, tx);
    if (effective.classificationVersion !== settings.classificationVersion)
      throw new LiekanError('规则已被更新，请重试当前批次', 409);
    await archiveCrawlerRules(tx, live.source.website_id, settings.rules, settings.crawlerRules);
    const rate = (
      await tx.$queryRawUnsafe(
        "SELECT (SELECT count(*)::int FROM liekan_ingest_batch WHERE website_id=$1::uuid AND state='pending') AS pending,(SELECT count(*)::int FROM liekan_ingest_batch WHERE website_id=$1::uuid AND received_at>now()-interval '1 minute') AS recent",
        live.source.website_id,
      )
    )[0];
    if (rate.pending >= 10000 || rate.recent >= 1200)
      throw new LiekanError('日志接收积压或速率超出上限，请稍后重试', 429);
    const resetAt = live.resetAt ? +new Date(live.resetAt) : 0;
    const valid = parsed.records.filter(row => +new Date(row.time) >= resetAt);
    const rejected = parsed.rejected + parsed.records.length - valid.length;
    if (warehouse) {
      await prepareWarehouseUpload(tx, {
        batchId,
        websiteId: live.source.website_id,
        sourceId,
        sourceEpoch: live.epoch,
        kind: 'automatic',
        digest,
        count: valid.length,
        actorId: live.source.created_by,
      });
      const repairScope = await collectionRepairScope(tx, live.source.website_id);
      await tx.$executeRawUnsafe(
        `INSERT INTO liekan_import(id,website_id,digest,accepted,rejected,kind,source_id,inserted,repair_scope_id)
        VALUES($1::uuid,$2::uuid,$3,0,$4,'automatic',$5::uuid,0,$6::uuid) ON CONFLICT(id) DO NOTHING`,
        batchId,
        live.source.website_id,
        digest,
        rejected,
        sourceId,
        repairScope,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO liekan_ingest_batch(id,website_id,source_id,epoch,digest,payload,received,valid,rejected,errors,catalog_version,repair_scope_id)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,NULL,$6,$7,$8,$9::jsonb,$10::uuid,$11::uuid) ON CONFLICT(id) DO NOTHING`,
        batchId,
        live.source.website_id,
        sourceId,
        live.epoch,
        digest,
        parsed.received,
        valid.length,
        rejected,
        JSON.stringify(parsed.errors),
        getPublishedCatalog()?.version ?? null,
        repairScope,
      );
      if (valid.length)
        await tx.$executeRawUnsafe(
          'UPDATE liekan_log_source SET last_received_at=clock_timestamp() WHERE id=$1::uuid',
          sourceId,
        );
      return {
        requestBatchId: upload.batchId,
        epoch: live.epoch,
        batchId,
        received: parsed.received,
        valid: valid.length,
        rejected,
        errors: parsed.errors,
        duplicate: !!old,
        warehouseDispatch: { batchId, websiteId: live.source.website_id, records: valid },
      };
    }
    await tx.$executeRawUnsafe(
      'INSERT INTO liekan_ingest_batch(id,website_id,source_id,epoch,digest,payload,received,valid,rejected,errors,catalog_version,repair_scope_id) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11::uuid,$12::uuid)',
      batchId,
      live.source.website_id,
      sourceId,
      live.epoch,
      digest,
      JSON.stringify(valid),
      parsed.received,
      valid.length,
      rejected,
      JSON.stringify(parsed.errors),
      getPublishedCatalog()?.version ?? null,
      await collectionRepairScope(tx, live.source.website_id),
    );
    await enqueue(tx, LOG_QUEUE, { batchId }, batchId);
    if (valid.length)
      await tx.$executeRawUnsafe(
        'UPDATE liekan_log_source SET last_received_at=now() WHERE id=$1::uuid',
        sourceId,
      );
    return {
      requestBatchId: upload.batchId,
      epoch: live.epoch,
      batchId,
      received: parsed.received,
      valid: valid.length,
      rejected,
      errors: parsed.errors,
      duplicate: false,
    };
  });
  if ('warehouseDispatch' in response) {
    const { warehouseDispatch, ...result } = response;
    await sendWarehouseUpload(warehouseDispatch);
    return result;
  }
  return response;
}
// Queue this worker's website batches before reserving connections. PostgreSQL source locks
// serialize batches from the same source across worker processes.
const websiteBatchTails = new Map<string, Promise<void>>();
async function withWebsiteBatchTurn(websiteId: string, work: () => Promise<void>) {
  const previous = websiteBatchTails.get(websiteId) || Promise.resolve();
  const pending = previous.catch(() => {}).then(work);
  websiteBatchTails.set(websiteId, pending);
  try {
    return await pending;
  } finally {
    if (websiteBatchTails.get(websiteId) === pending) websiteBatchTails.delete(websiteId);
  }
}
export async function processBatch(batchId: string) {
  if (
    warehouseIntakeEnabled() &&
    (await query('SELECT 1 FROM liekan_warehouse_upload WHERE batch_id=$1::uuid', uuid(batchId)))
      .length
  )
    return;
  const first = (
    await query(
      'SELECT website_id,source_id,state FROM liekan_ingest_batch WHERE id=$1::uuid',
      uuid(batchId),
    )
  )[0];
  if (!first || first.state !== 'pending') return;
  return withWebsiteBatchTurn(first.website_id, () =>
    transaction(async tx => {
      const live = await validateSource(tx, first.source_id, undefined, true, 'share');
      const batch = (
        await tx.$queryRawUnsafe(
          'SELECT * FROM liekan_ingest_batch WHERE id=$1::uuid FOR UPDATE',
          batchId,
        )
      )[0];
      if (!batch || batch.state !== 'pending') return;
      if (batch.epoch !== live.epoch) {
        await tx.$executeRawUnsafe(
          "UPDATE liekan_ingest_batch SET state='cancelled',payload=NULL WHERE id=$1::uuid",
          batchId,
        );
        return;
      }
      const rows: AutomaticRecord[] = batch.payload || [];
      const resetAt = live.resetAt ? +new Date(live.resetAt) : 0;
      const valid = rows.filter(row => +new Date(row.time) >= resetAt);
      // Keep incoming records as the lookup driver. The runtime site value avoids
      // stale new-site MCV estimates choosing a site-prefix scan for every record.
      const conflicting = await tx.$queryRawUnsafe(
        `SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS r(id text,"eventDigest" text)
       JOIN LATERAL (SELECT event_digest FROM liekan_log l
         WHERE l.website_id=(SELECT $1::uuid OFFSET 0) AND l.id=r.id OFFSET 0) l ON true
       WHERE l.event_digest IS DISTINCT FROM r."eventDigest" LIMIT 1`,
        first.website_id,
        JSON.stringify(valid),
      );
      if (conflicting.length) throw new LiekanError('事件标识对应内容发生冲突', 409);
      await tx.$executeRawUnsafe(
        "INSERT INTO liekan_import(id,website_id,digest,accepted,rejected,kind,source_id,inserted,repair_scope_id) VALUES($1::uuid,$2::uuid,$3,0,$4,'automatic',$5::uuid,0,$6::uuid)",
        batchId,
        first.website_id,
        batch.digest,
        batch.rejected,
        first.source_id,
        batch.repair_scope_id ?? null,
      );
      let inserted = 0;
      if (valid.length)
        inserted = await tx.$executeRawUnsafe(
          `INSERT INTO liekan_log(id,website_id,import_id,source_id,event_digest,verification_version,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state,recognition_candidates,verification_observed_at,verification_reason)
      SELECT r.id,$1::uuid,$2::uuid,$3::uuid,r."eventDigest",r."verificationVersion",r.time::timestamptz,r.path,r.method,r.status,r.bytes,r."ipMasked",r."ipHash",r."userAgent",r.location,r.bot,r.vendor,r.type,r.verification,r."aiEligible",r."recognitionState",r."recognitionCandidates",r."verificationObservedAt"::timestamptz,r."verificationReason"
      FROM jsonb_to_recordset($4::jsonb) AS r(id text,"eventDigest" text,"verificationVersion" text,time text,path text,method text,status integer,bytes bigint,"ipMasked" text,"ipHash" text,"userAgent" text,location text,bot text,vendor text,type text,verification text,"aiEligible" boolean,"recognitionState" text,"recognitionCandidates" jsonb,"verificationObservedAt" text,"verificationReason" text) ON CONFLICT(website_id,id) DO NOTHING`,
          first.website_id,
          batchId,
          first.source_id,
          JSON.stringify(valid),
        );
      await persistLogGeography(tx, first.website_id, valid);
      await persistCrawlerEvidence(tx, first.website_id, batchId, valid);
      await tx.$executeRawUnsafe(
        'UPDATE liekan_import SET accepted=(SELECT count(*)::int FROM liekan_effective_log WHERE import_id=$1::uuid),inserted=$2 WHERE id=$1::uuid',
        batchId,
        inserted,
      );
      await tx.$executeRawUnsafe(
        "UPDATE liekan_ingest_batch SET state='processed',payload=NULL,inserted=$2,duplicates=$3,processed_at=now() WHERE id=$1::uuid",
        batchId,
        inserted,
        valid.length - inserted,
      );
      if (inserted) {
        await tx.$executeRawUnsafe(
          'UPDATE liekan_log_state SET data_revision=data_revision+1,updated_at=now() WHERE website_id=$1::uuid',
          first.website_id,
        );
        await tx.$executeRawUnsafe(
          'UPDATE liekan_log_source SET last_processed_at=now() WHERE id=$1::uuid',
          first.source_id,
        );
      }
    }),
  );
}
export async function collectorConnection(sourceId: string, token: string) {
  return transaction(async tx => {
    const live = await validateSource(tx, sourceId, token, true);
    return {
      version: 1,
      websiteId: live.source.website_id,
      state: live.source.state,
      epoch: live.epoch,
    };
  });
}
export async function heartbeat(sourceId: string, token: string, input: unknown) {
  const health = healthSchema.safeParse(input);
  if (!health.success) throw new LiekanError('健康状态无效');
  let warehouseProof: WarehouseCrawlerCoverage;
  const proof = health.data.coverage;
  if (
    warehouseEnabled() &&
    proof &&
    !health.data.gap &&
    health.data.errorCode === 'none' &&
    !health.data.pending
  ) {
    const initial = await transaction(async tx => {
      const live = await validateSource(tx, sourceId, token, true, 'share');
      const settings = await getSettings(live.source.website_id, tx);
      return {
        ...live,
        version: crawlerClassificationVersion(settings.rules, settings.crawlerRules),
      };
    });
    if (
      initial.source.kind === 'server' &&
      initial.source.state === 'active' &&
      proof.epoch === initial.epoch &&
      proof.endsAt <= Date.now() &&
      proof.cursors.every(cursor => cursor.confirmed === cursor.read)
    ) {
      try {
        warehouseProof = await prepareWarehouseCrawlerCoverage(
          initial.source.website_id,
          sourceId,
          initial.epoch,
          proof,
          initial.version,
        );
      } catch {
        // Collection health and gap reporting remain available during an
        // analytics outage. No complete proof is published without CH evidence.
      }
    }
  }
  return transaction(async tx => {
    const live = await validateSource(tx, sourceId, token, true);
    await tx.$executeRawUnsafe(
      'UPDATE liekan_log_source SET last_heartbeat_at=now(),health=$2::jsonb WHERE id=$1::uuid',
      sourceId,
      JSON.stringify(health.data),
    );
    if (
      live.source.kind === 'server' &&
      live.source.state === 'configuring' &&
      health.data.errorCode === 'none'
    ) {
      const state = await ensureState(tx, live.source.website_id);
      if (String(state.policy_revision) === String(live.source.requested_policy_revision)) {
        await activateSource(tx, live.source);
        live.source.state = 'active';
      } else {
        await tx.$executeRawUnsafe(
          "UPDATE liekan_log_source SET state='paused',error_code='confirmation-required' WHERE id=$1::uuid",
          sourceId,
        );
        live.source.state = 'paused';
      }
    }
    const setting = await getSettings(live.source.website_id, tx);
    const coverage = await recordCrawlerCoverage(
      tx,
      live.source,
      live.epoch,
      health.data,
      setting.rules,
      Date.now(),
      setting.crawlerRules,
      warehouseProof,
    );
    return {
      version: 1,
      coverageVersion: 1,
      coverageGapRecorded: coverage?.gapRecorded === true,
      coverageBinding:
        String((await ensureState(tx, live.source.website_id)).policy_revision) +
        ':' +
        crawlerClassificationVersion(setting.rules, setting.crawlerRules),
      epoch: live.epoch,
      state: live.source.state,
      resetAt: live.resetAt,
      batchSize: 1000,
      heartbeatSeconds: 60,
    };
  });
}
export async function manageSource(
  websiteId: string,
  sourceId: string,
  body: unknown,
  identity: WriteIdentity,
) {
  const parsed = z
    .strictObject({ action: z.enum(['pause', 'resume', 'select', 'rotate']) })
    .safeParse(body);
  if (!parsed.success) throw new LiekanError('来源操作无效');
  const action = parsed.data.action;
  const result = await transaction(async tx => {
    await sourceWebsite(tx, websiteId, identity);
    const source: LogSource = (
      await tx.$queryRawUnsafe(
        'SELECT * FROM liekan_log_source WHERE id=$1::uuid AND website_id=$2::uuid FOR UPDATE',
        uuid(sourceId),
        websiteId,
      )
    )[0];
    if (!source || source.state === 'disconnected') throw new LiekanError('日志来源不存在', 404);
    if (action === 'pause') {
      await tx.$executeRawUnsafe(
        "UPDATE liekan_log_source SET state='paused' WHERE id=$1::uuid",
        sourceId,
      );
      await tx.$executeRawUnsafe(
        'UPDATE liekan_log_interval SET ends_at=clock_timestamp() WHERE source_id=$1::uuid AND ends_at IS NULL',
        sourceId,
      );
    } else if (action === 'rotate') {
      if (!source.credential_hash) throw new LiekanError('接入凭据已失效，请重新连接', 409);
      const token = newToken();
      await tx.$executeRawUnsafe(
        'UPDATE liekan_log_source SET credential_hash=$2,credential_version=credential_version+1 WHERE id=$1::uuid',
        sourceId,
        tokenHash(token),
      );
      if (source.kind === 'cloudflare') throw new LiekanError('Cloudflare 凭据轮换请重新授权', 409);
      return { token };
    } else {
      if (!source.credential_hash || (source.kind === 'cloudflare' && !source.provider_config))
        throw new LiekanError('接入凭据已失效，请重新连接', 409);
      await validateSource(tx, sourceId, undefined, true);
      const state = await ensureState(tx, websiteId);
      source.requested_policy_revision = state.policy_revision;
      await tx.$executeRawUnsafe(
        'UPDATE liekan_log_source SET requested_policy_revision=$2 WHERE id=$1::uuid',
        sourceId,
        state.policy_revision,
      );
      if (source.kind === 'cloudflare') {
        await tx.$executeRawUnsafe(
          "UPDATE liekan_log_source SET state='configuring' WHERE id=$1::uuid",
          sourceId,
        );
        await enqueue(tx, PROVIDER_QUEUE, { sourceId, action: 'configure' });
        return { saved: true };
      }
      await activateSource(tx, source);
    }
    if (action === 'pause')
      await tx.$executeRawUnsafe(
        'UPDATE liekan_log_state SET policy_revision=policy_revision+1 WHERE website_id=$1::uuid',
        websiteId,
      );
    if (action === 'pause' && source.kind === 'cloudflare')
      await enqueue(tx, PROVIDER_QUEUE, { sourceId, action: 'health' });
    return { saved: true };
  });
  invalidateWebsiteAnalytics(websiteId);
  return result;
}
export async function disconnectSource(
  websiteId: string,
  sourceId: string,
  identity: WriteIdentity,
) {
  return transaction(async tx => {
    await sourceWebsite(tx, websiteId, identity);
    const source: LogSource = (
      await tx.$queryRawUnsafe(
        'SELECT * FROM liekan_log_source WHERE id=$1::uuid AND website_id=$2::uuid FOR UPDATE',
        uuid(sourceId),
        websiteId,
      )
    )[0];
    if (!source) throw new LiekanError('日志来源不存在', 404);
    await tx.$executeRawUnsafe(
      "UPDATE liekan_log_source SET state='disconnected',credential_hash=NULL WHERE id=$1::uuid",
      sourceId,
    );
    await tx.$executeRawUnsafe(
      'UPDATE liekan_log_interval SET ends_at=clock_timestamp() WHERE source_id=$1::uuid AND ends_at IS NULL',
      sourceId,
    );
    await tx.$executeRawUnsafe(
      "UPDATE liekan_ingest_batch SET state='cancelled',payload=NULL WHERE source_id=$1::uuid AND state='pending'",
      sourceId,
    );
    await tx.$executeRawUnsafe(
      'UPDATE liekan_log_state SET policy_revision=policy_revision+1 WHERE website_id=$1::uuid',
      websiteId,
    );
    if (source.kind === 'cloudflare' && source.provider_job_id)
      await enqueue(tx, PROVIDER_QUEUE, { sourceId, action: 'disconnect' });
    return { disconnected: true };
  });
}
