import { discoverAnalysisRollups } from './analysis-rollups-discovery';
import { buildBrowserDetailChunk } from './browser-detail-facts';
import { boundedBrowserEventsSql } from './bounded-browser-events';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';
import { CRAWLER_POPULATION_VERSION } from '../rules/population';
import { randomUUID } from 'node:crypto';
import { lockWritableWebsite } from './server';
import {
  hasAnalysisBuildCapacity,
  storageHistoryAllowed,
  storageHistorySiteAllowedSql,
} from './storage-capacity';
import {
  analysisTransaction,
  analysisVersions,
  analysisCapacity,
  analysisLogDimensionsSql,
  analysisVisitRowsSql,
  ensureAnalysisPartitions,
  chargeAnalysisGeneration,
  assertAnalysisGenerationWritable,
} from './analysis-rollups-db';
import {
  analysisHash,
  ANALYSIS_ROLLUP_VERSION,
  ANALYSIS_CHUNK_SIZE,
  analysisNextBoundary,
  analysisCompletedUnits,
  analysisBuildPrioritySql,
  type AnalysisBuildRow,
  type AnalysisCheckpoint,
  type AnalysisTx,
} from './analysis-rollups-model';

async function assertAuthority(tx: AnalysisTx, row: AnalysisBuildRow) {
  await lockWritableWebsite(
    tx,
    row.website_id,
    row.actor_id ? { userId: row.actor_id } : undefined,
    'share',
  );
  const [site] = await tx.$queryRawUnsafe<{ epoch: bigint; mode: string }[]>(
    'SELECT epoch,mode FROM liekan_analysis_site WHERE website_id=$1::uuid FOR SHARE',
    row.website_id,
  );
  if (!site || site.mode !== 'live' || String(site.epoch) !== String(row.epoch))
    throw new Error('analysis-epoch-changed');
}
async function fingerprint(tx: AnalysisTx, row: AnalysisBuildRow, state: AnalysisCheckpoint) {
  const [value] = await tx.$queryRawUnsafe<{ fingerprint: string }[]>(
    'SELECT liekan_analysis_fingerprint($1::uuid,$2::bigint,$3,$4::timestamptz,$5::timestamptz) AS fingerprint',
    row.website_id,
    String(row.epoch),
    state.family,
    state.hour,
    state.spanEnd,
  );
  return value.fingerprint;
}
async function logChunk(tx: AnalysisTx, row: AnalysisBuildRow, state: AnalysisCheckpoint) {
  const [result] = await tx.$queryRawUnsafe<
    { rows: string; after_time: string | null; after_id: string | null; bytes: string }[]
  >(
    `WITH eligible_ids AS MATERIALIZED (
     SELECT l.id,l.created_at FROM liekan_effective_log l
     WHERE l.website_id=$1::uuid AND l.created_at>=$3::timestamptz AND l.created_at<$4::timestamptz
     AND ($5::timestamptz IS NULL OR (l.created_at,l.id)>($5::timestamptz,$6::text))
     ORDER BY l.created_at,l.id LIMIT $7
    ), raw AS MATERIALIZED (
     SELECT l.* FROM eligible_ids k CROSS JOIN LATERAL (
      SELECT l.id,l.created_at,l.path,l.bot,l.vendor,l.bot_type,l.reporting_crawler_id,l.reporting_catalog_version,l.reporting_classification_version,
       l.ai_eligible,l.recognition_state,l.verification,l.user_agent,l.status
      FROM liekan_reporting_log l WHERE l.website_id=$1::uuid AND l.id=k.id OFFSET 0
     ) l
    ), wanted AS MATERIALIZED (
     SELECT DISTINCT reporting_catalog_version,reporting_crawler_id FROM raw
    ), selected_versions AS MATERIALIZED (
     SELECT DISTINCT reporting_catalog_version FROM wanted WHERE reporting_catalog_version IS NOT NULL
    ), expanded AS MATERIALIZED (
     SELECT v.version AS catalog_version,item.identity->>'id' AS crawler_id,item.identity->>'productForm' AS product_form,item.ordinal
     FROM selected_versions requested JOIN liekan_crawler_registry_version v ON v.version=requested.reporting_catalog_version
     CROSS JOIN LATERAL jsonb_array_elements(v.payload->'identities') WITH ORDINALITY item(identity,ordinal)
    ), forms AS MATERIALIZED (
     SELECT DISTINCT ON(e.catalog_version,e.crawler_id) e.catalog_version,e.crawler_id,e.product_form FROM expanded e
     JOIN wanted w ON w.reporting_catalog_version=e.catalog_version AND w.reporting_crawler_id=e.crawler_id
     ORDER BY e.catalog_version,e.crawler_id,e.ordinal
    ), chunk AS MATERIALIZED (
     SELECT l.id,l.created_at,l.path,${analysisLogDimensionsSql('f.product_form')} AS dimensions FROM raw l
     LEFT JOIN forms f ON f.catalog_version=l.reporting_catalog_version AND f.crawler_id=l.reporting_crawler_id
    ), counters AS (
     INSERT INTO liekan_analysis_log(website_id,generation,grain,bucket,dimensions,dimension_key,requests,first_at,last_at)
     SELECT $1::uuid,$2::uuid,g.grain,date_bin(g.span,c.created_at,timestamptz '2000-01-01Z'),c.dimensions,md5(c.dimensions::text),count(*),min(c.created_at),max(c.created_at)
     FROM chunk c CROSS JOIN (VALUES('5m',interval '5 minutes'),('hour',interval '1 hour')) g(grain,span) GROUP BY 3,4,5,6
     ON CONFLICT(website_id,generation,grain,bucket,dimension_key) DO UPDATE SET
      requests=liekan_analysis_merge_count(liekan_analysis_log.dimensions,EXCLUDED.dimensions,liekan_analysis_log.requests,EXCLUDED.requests),first_at=least(liekan_analysis_log.first_at,EXCLUDED.first_at),last_at=greatest(liekan_analysis_log.last_at,EXCLUDED.last_at),updated_at=clock_timestamp()
     RETURNING pg_column_size(liekan_analysis_log)*2 AS bytes
    ), paths AS (
     INSERT INTO liekan_analysis_path(website_id,generation,bucket,path,dimensions,dimension_key,requests,first_at,last_at)
     SELECT $1::uuid,$2::uuid,date_bin(interval '1 hour',c.created_at,timestamptz '2000-01-01Z'),c.path,c.dimensions,md5(c.dimensions::text),count(*),min(c.created_at),max(c.created_at)
     FROM chunk c WHERE $8::boolean GROUP BY 3,c.path,c.dimensions
     ON CONFLICT(website_id,generation,bucket,path,dimension_key) DO UPDATE SET
      requests=liekan_analysis_merge_count(liekan_analysis_path.dimensions,EXCLUDED.dimensions,liekan_analysis_path.requests,EXCLUDED.requests),first_at=least(liekan_analysis_path.first_at,EXCLUDED.first_at),last_at=greatest(liekan_analysis_path.last_at,EXCLUDED.last_at),updated_at=clock_timestamp()
     RETURNING pg_column_size(liekan_analysis_path)*2 AS bytes
    ) SELECT (coalesce((SELECT sum(bytes) FROM counters),0)+coalesce((SELECT sum(bytes) FROM paths),0))::text AS bytes,count(*)::text AS rows,(SELECT created_at::text FROM chunk ORDER BY created_at DESC,id DESC LIMIT 1) AS after_time,
     (SELECT id FROM chunk ORDER BY created_at DESC,id DESC LIMIT 1) AS after_id FROM chunk`,
    row.website_id,
    state.generation,
    state.hour,
    state.spanEnd,
    state.afterTime || null,
    state.afterId || '',
    state.chunkSize || ANALYSIS_CHUNK_SIZE,
    state.pathComplete !== false,
  );
  return result;
}
async function visitChunk(tx: AnalysisTx, row: AnalysisBuildRow, state: AnalysisCheckpoint) {
  // Expanded policy compilation can consume the short unit's SQL budget before reading its page.
  await tx.$executeRawUnsafe('SET LOCAL jit=off');
  const condition = `e.website_id=$1::uuid AND e.created_at>=$3::timestamptz AND e.created_at<$4::timestamptz
     AND ($5::timestamptz IS NULL OR (e.created_at,e.event_id)>($5::timestamptz,$6::uuid))`;
  const [result] = await tx.$queryRawUnsafe<
    {
      rows: string;
      input_rows: string;
      after_time: string | null;
      after_id: string | null;
      bytes: string;
    }[]
  >(
    `WITH physical_page AS MATERIALIZED (
     SELECT e.event_id,e.created_at FROM (TABLE website_event) e WHERE ${condition}
     ORDER BY e.created_at,e.event_id LIMIT $7
    ), ${boundedBrowserEventsSql(condition, { geography: true, environment: true, physicalKeys: 'physical_page' })},
    observed AS (${analysisVisitRowsSql(condition, 'bounded_events')}), chunk AS MATERIALIZED (
     SELECT * FROM observed
    ), facts AS (
     INSERT INTO liekan_analysis_visit(website_id,generation,bucket,session_id,visit_id,hostname,dimensions,dimension_key,eligible_events,pageviews,has_custom,min_time,max_time)
     SELECT $1::uuid,$2::uuid,date_bin(interval '1 hour',c.created_at,timestamptz '2000-01-01Z'),c.session_id,c.visit_id,c.hostname,c.dimensions,md5(c.dimensions::text),
       count(*),count(*) FILTER(WHERE c.event_type NOT IN(2,5)),bool_or(c.event_type=2),
       min(c.created_at) FILTER(WHERE c.event_type NOT IN(2,5)),max(c.created_at) FILTER(WHERE c.event_type NOT IN(2,5))
     FROM chunk c GROUP BY 3,c.session_id,c.visit_id,c.hostname,c.dimensions
     ON CONFLICT(website_id,generation,bucket,session_id,visit_id,hostname,dimension_key) DO UPDATE SET
       eligible_events=liekan_analysis_merge_count(liekan_analysis_visit.dimensions,EXCLUDED.dimensions,liekan_analysis_visit.eligible_events,EXCLUDED.eligible_events),
       pageviews=liekan_analysis_visit.pageviews+EXCLUDED.pageviews,
       has_custom=liekan_analysis_visit.has_custom OR EXCLUDED.has_custom,
       min_time=least(liekan_analysis_visit.min_time,EXCLUDED.min_time),max_time=greatest(liekan_analysis_visit.max_time,EXCLUDED.max_time),updated_at=clock_timestamp()
     RETURNING pg_column_size(liekan_analysis_visit)*2 AS bytes
    ) SELECT coalesce((SELECT sum(bytes) FROM facts),0)::text AS bytes,count(*)::text AS rows,
     (SELECT count(*)::text FROM physical_page) AS input_rows,
     (SELECT created_at::text FROM physical_page ORDER BY created_at DESC,event_id DESC LIMIT 1) AS after_time,
     (SELECT event_id::text FROM physical_page ORDER BY created_at DESC,event_id DESC LIMIT 1) AS after_id FROM chunk`,
    row.website_id,
    state.generation,
    state.hour,
    state.spanEnd,
    state.afterTime || null,
    state.afterId || '00000000-0000-0000-0000-000000000000',
    state.chunkSize || ANALYSIS_CHUNK_SIZE,
  );
  return result;
}
async function updateCheckpoint(tx: AnalysisTx, row: AnalysisBuildRow, state: AnalysisCheckpoint) {
  const count = await tx.$executeRawUnsafe(
    `UPDATE liekan_analysis_build SET checkpoint=$3::jsonb,lease_until=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp()
     WHERE id=$1::uuid AND lease_token=$2::uuid AND lease_until>clock_timestamp() AND status='running'`,
    row.id,
    row.lease_token,
    JSON.stringify(state),
  );
  if (!count) throw new Error('analysis-lease-lost');
}

function candidateBoundary(row: AnalysisBuildRow, state: AnalysisCheckpoint) {
  if (state.stage === 'canary') return new Date(state.canaryUntil);
  if (state.canaryFrom && +new Date(state.hour) < +new Date(state.canaryFrom))
    return new Date(Math.min(+row.range_end, +new Date(state.canaryFrom)));
  return row.range_end;
}
function clearCandidate(state: AnalysisCheckpoint): AnalysisCheckpoint {
  return {
    hour: state.hour,
    family: state.family,
    stage: state.stage,
    canaryFrom: state.canaryFrom,
    canaryUntil: state.canaryUntil,
  };
}
function advanceCheckpoint(row: AnalysisBuildRow, state: AnalysisCheckpoint, end: string) {
  const base = clearCandidate(state);
  if (state.stage === 'canary') {
    if (+new Date(end) < +new Date(state.canaryUntil))
      return { complete: false, next: { ...base, hour: end } };
    if (state.family === 'log')
      return {
        complete: false,
        next: { ...base, hour: state.canaryFrom, family: 'visit' as const },
      };
    const hour =
      +row.range_start === +new Date(state.canaryFrom)
        ? state.canaryUntil
        : row.range_start.toISOString();
    return {
      complete: +new Date(hour) >= +row.range_end,
      next: { ...base, stage: 'history' as const, hour, family: 'log' as const },
    };
  }
  let hour = end;
  if (
    state.canaryFrom &&
    +new Date(hour) >= +new Date(state.canaryFrom) &&
    +new Date(hour) < +new Date(state.canaryUntil)
  )
    hour = state.canaryUntil;
  if (+new Date(hour) < +row.range_end) return { complete: false, next: { ...base, hour } };
  if (row.family !== 'both' || state.family === 'visit') return { complete: true, next: {} };
  const start =
    state.canaryFrom && +row.range_start === +new Date(state.canaryFrom)
      ? state.canaryUntil
      : row.range_start.toISOString();
  return {
    complete: +new Date(start) >= +row.range_end,
    next: { ...base, hour: start, family: 'visit' as const },
  };
}

async function queueRecovery(
  tx: AnalysisTx,
  site: string,
  epoch: string,
  family: 'log' | 'visit',
  from: Date,
  until: Date,
  actorId: string | null,
  origin: string,
  originBuildId: string | null = null,
  excludingBuildId: string | null = null,
  requestedUnit?: 300 | 3600,
  recoverCapacity = false,
) {
  if (+until <= +from) return 0;
  const unit = requestedUnit ?? (family === 'log' ? 300 : 3600);
  const [pin] = await tx.$queryRawUnsafe<
    { fingerprint: string; versions: Record<string, unknown> }[]
  >(
    'SELECT liekan_analysis_fingerprint($1::uuid,$2::bigint,$3,$4,$5) AS fingerprint,liekan_analysis_versions($1::uuid,$6,$7,$8) AS versions',
    site,
    epoch,
    family,
    from,
    until,
    ANALYSIS_ROLLUP_VERSION,
    TRAFFIC_POLICY_VERSION,
    CRAWLER_POPULATION_VERSION,
  );
  const digest = analysisHash([
    site,
    epoch,
    family,
    from.toISOString(),
    until.toISOString(),
    pin.fingerprint,
    pin.versions,
    originBuildId,
    unit,
    origin,
  ]);
  const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return tx.$executeRawUnsafe(
    `INSERT INTO liekan_analysis_build(id,website_id,actor_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total,origin_build_id)
  SELECT $1::uuid,$2::uuid,$3::uuid,$4::bigint,$5,$6,$7,$8,'UTC','zh-CN',$9::uuid,$10,'queued',$11::bigint,$12::uuid
  WHERE NOT EXISTS(SELECT 1 FROM liekan_analysis_build b WHERE b.website_id=$2::uuid AND b.epoch=$4::bigint AND (b.family='both' OR b.family=$5)
   AND b.actor_id IS NULL AND NOT b.automatic_history AND b.unit_seconds=$6 AND b.status IN('queued','running','paused') AND b.range_start<$8::timestamptz AND b.range_end>$7::timestamptz AND b.id IS DISTINCT FROM $13::uuid)
  ON CONFLICT(website_id,request_id) DO UPDATE SET status='queued',attempts=0,error_code=NULL,
   lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp(),revision=liekan_analysis_build.revision+1,updated_at=clock_timestamp()
  WHERE $14::boolean AND liekan_analysis_build.status='capacity_limited'
   AND liekan_analysis_build.error_code='analysis-capacity-limited'
   AND liekan_analysis_build.actor_id IS NULL AND NOT liekan_analysis_build.automatic_history
   AND liekan_analysis_build.next_attempt_at<=clock_timestamp()
   AND EXISTS(SELECT 1 FROM liekan_analysis_site s WHERE s.website_id=EXCLUDED.website_id
    AND s.epoch=EXCLUDED.epoch AND s.mode='live' AND ${storageHistorySiteAllowedSql}
    AND (EXCLUDED.family<>'visit' OR s.visit_expansion))`,
    randomUUID(),
    site,
    actorId,
    epoch,
    family,
    unit,
    from,
    until,
    requestId,
    origin,
    Math.ceil((+until - +from) / (unit * 1000)),
    originBuildId,
    excludingBuildId,
    recoverCapacity,
  );
}

/** One <=2000-row keyset chunk or one atomic manifest publication per call. */
export async function runOneAnalysisWorkUnit(
  buildId?: string,
  globalLease?: { token: string; epoch: string },
  observer?: {
    beforeCandidateCommit?: () => Promise<void>;
    afterPublicationAuthority?: () => Promise<void>;
  },
): Promise<{ worked: boolean; buildId?: string }> {
  if (process.env.CLICKHOUSE_URL) return { worked: false };
  const row = await analysisTransaction(async tx => {
    const [candidate] = await tx.$queryRawUnsafe<AnalysisBuildRow[]>(
      `SELECT b.* FROM liekan_analysis_build b WHERE status IN('queued','running') AND next_attempt_at<=now()
       AND (lease_until IS NULL OR lease_until<clock_timestamp()) AND ($1::uuid IS NULL OR id=$1::uuid)
       ORDER BY ${analysisBuildPrioritySql},created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
      buildId || null,
    );
    if (!candidate) return null;
    const token = randomUUID();
    await tx.$executeRawUnsafe(
      `UPDATE liekan_analysis_build SET status='running',lease_token=$2::uuid,lease_until=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp() WHERE id=$1::uuid`,
      candidate.id,
      token,
    );
    return { ...candidate, status: 'running' as const, lease_token: token };
  });
  if (!row) return { worked: false };
  try {
    // A fresh snapshot per bounded chunk is validated against the original mutation fingerprint.
    await analysisTransaction(async tx => {
      await assertAuthority(tx, row);
      const state: AnalysisCheckpoint = {
        hour: row.range_start.toISOString(),
        family: row.family === 'visit' ? 'visit' : 'log',
        ...row.checkpoint,
      };
      const boundedEnd = new Date(
        Math.min(
          +analysisNextBoundary(state.hour, row.unit_seconds),
          +candidateBoundary(row, state),
        ),
      ).toISOString();
      const wholeHour =
        state.family === 'log' &&
        +new Date(state.hour) % 3600000 === 0 &&
        +new Date(boundedEnd) - +new Date(state.hour) === 3600000 &&
        +new Date(boundedEnd) <= Date.now() - 30000;
      const [expansion] = await tx.$queryRawUnsafe<
        { path_expansion: boolean; visit_expansion: boolean }[]
      >(
        'SELECT path_expansion,visit_expansion FROM liekan_analysis_site WHERE website_id=$1::uuid',
        row.website_id,
      );
      if (state.family === 'visit' && !expansion.visit_expansion)
        throw new Error('analysis-visit-expansion-stopped');
      if (
        state.generation &&
        (+new Date(state.spanEnd) > +new Date(boundedEnd) ||
          (state.family === 'log' &&
            state.pathComplete !== false &&
            (!expansion.path_expansion || !wholeHour)))
      ) {
        await updateCheckpoint(tx, row, clearCandidate(state));
        return;
      }
      if (!state.generation) {
        const capacity = await analysisCapacity(tx, row.website_id);
        if (!hasAnalysisBuildCapacity(capacity)) throw new Error('analysis-capacity-limited');
        state.pathComplete = expansion.path_expansion && wholeHour;
        state.generation = randomUUID();
        state.chunkSize = Math.max(100, Math.floor(ANALYSIS_CHUNK_SIZE / 2 ** row.attempts));
        state.spanEnd = boundedEnd;
        state.versions = await analysisVersions(tx, row.website_id);
        state.fingerprint = await fingerprint(tx, row, state);
      } else if (
        state.fingerprint !== (await fingerprint(tx, row, state)) ||
        JSON.stringify(state.versions) !==
          JSON.stringify(await analysisVersions(tx, row.website_id))
      ) {
        // Discard candidate state; its unreachable rows remain eligible for the storage policy.
        await updateCheckpoint(tx, row, clearCandidate(state));
        return;
      }
      if (state.afterId === '__publish__') return;
      state.chunkSize = Math.min(
        state.chunkSize || ANALYSIS_CHUNK_SIZE,
        Math.max(100, Math.floor(ANALYSIS_CHUNK_SIZE / 2 ** row.attempts)),
      );
      await ensureAnalysisPartitions(tx, state.hour);
      const chunk =
        state.family === 'log' ? await logChunk(tx, row, state) : await visitChunk(tx, row, state);
      if (state.family === 'visit') {
        const detail = await buildBrowserDetailChunk(tx, row, state, chunk);
        chunk.bytes = String(BigInt(chunk.bytes) + BigInt(detail.bytes));
      }
      await chargeAnalysisGeneration(tx, row.website_id, state.generation, chunk.bytes);
      const chunkCapacity = await analysisCapacity(tx, row.website_id);
      if (!hasAnalysisBuildCapacity(chunkCapacity)) throw new Error('analysis-capacity-limited');
      state.rows = String(BigInt(state.rows || '0') + BigInt(chunk.rows));
      if (chunk.after_time) {
        state.afterTime = chunk.after_time;
        state.afterId = chunk.after_id;
      }
      // Physical pages advance even when every event is excluded from observed facts.
      const inputRows = 'input_rows' in chunk ? chunk.input_rows : chunk.rows;
      if (Number(inputRows) === (state.chunkSize || ANALYSIS_CHUNK_SIZE)) {
        await updateCheckpoint(tx, row, state);
      } else {
        // Publication uses a separate current snapshot to detect mutations committed during this chunk.
        await updateCheckpoint(tx, row, { ...state, afterId: '__publish__' });
        await observer?.beforeCandidateCommit?.();
      }
    }, 'RepeatableRead');
    await analysisTransaction(async tx => {
      // Management takes website/site locks before build locks; publication follows the same order.
      await assertAuthority(tx, row);
      await observer?.afterPublicationAuthority?.();
      const [fresh] = await tx.$queryRawUnsafe<AnalysisBuildRow[]>(
        "SELECT * FROM liekan_analysis_build WHERE id=$1::uuid AND lease_token=$2::uuid AND status='running' AND lease_until>clock_timestamp() FOR UPDATE",
        row.id,
        row.lease_token,
      );
      if (!fresh) throw new Error('analysis-lease-lost');
      await assertAuthority(tx, fresh);
      if (globalLease) {
        const [permit] = await tx.$queryRawUnsafe<{ valid: boolean }[]>(
          'SELECT (token=$1::uuid AND epoch=$2::bigint AND lease_until>clock_timestamp()) AS valid FROM liekan_analysis_background_lease WHERE id FOR SHARE',
          globalLease.token,
          globalLease.epoch,
        );
        if (!permit?.valid) throw new Error('analysis-global-lease-lost');
      }
      const state = fresh.checkpoint;
      if (state.afterId !== '__publish__') return;
      await assertAnalysisGenerationWritable(tx, fresh.website_id, state.generation);
      if (
        state.fingerprint !== (await fingerprint(tx, fresh, state)) ||
        JSON.stringify(state.versions) !==
          JSON.stringify(await analysisVersions(tx, fresh.website_id))
      ) {
        await updateCheckpoint(tx, fresh, clearCandidate(state));
        return;
      }
      let spanEnd = state.spanEnd;
      if (state.rows === '0') {
        const table = state.family === 'log' ? 'liekan_log' : 'website_event';
        const [next] = await tx.$queryRawUnsafe<{ at: Date | null }[]>(
          `SELECT min(created_at) AS at FROM ${table} WHERE website_id=$1::uuid AND created_at>=$2::timestamptz AND created_at<$3::timestamptz`,
          fresh.website_id,
          spanEnd,
          candidateBoundary(fresh, state),
        );
        spanEnd = next.at
          ? new Date(
              Math.floor(+next.at / (fresh.unit_seconds * 1000)) * fresh.unit_seconds * 1000,
            ).toISOString()
          : candidateBoundary(fresh, state).toISOString();
        if (+new Date(spanEnd) < +new Date(state.spanEnd)) spanEnd = state.spanEnd;
        // The wider span is proved empty in this snapshot and carries its own fingerprint.
        state.spanEnd = spanEnd;
        state.fingerprint = await fingerprint(tx, fresh, state);
      }
      const capacity = await analysisCapacity(tx, fresh.website_id);
      if (!hasAnalysisBuildCapacity(capacity)) throw new Error('analysis-capacity-limited');
      // Remove overlapping empty-span manifests before installing the mutually exclusive replacement.
      // Preserve published generations via the previous_generation pointer for ordinary replacement.
      const overlaps = await tx.$queryRawUnsafe<
        {
          bucket: Date;
          bucket_end: Date;
          generation: string;
          previous_generation: string | null;
          build_id: string | null;
          fingerprint: string;
          versions: unknown;
          row_count: bigint;
        }[]
      >(
        `SELECT * FROM liekan_analysis_manifest WHERE website_id=$1::uuid AND epoch=$2::bigint AND family=$3 AND bucket<$5::timestamptz AND bucket_end>$4::timestamptz FOR UPDATE`,
        fresh.website_id,
        String(fresh.epoch),
        state.family,
        state.hour,
        spanEnd,
      );
      for (const overlap of overlaps) {
        await tx.$executeRawUnsafe(
          'DELETE FROM liekan_analysis_manifest WHERE website_id=$1::uuid AND epoch=$2::bigint AND family=$3 AND bucket=$4::timestamptz',
          fresh.website_id,
          String(fresh.epoch),
          state.family,
          overlap.bucket,
        );
        for (const [from, until] of [
          [overlap.bucket, new Date(state.hour)],
          [new Date(spanEnd), overlap.bucket_end],
        ]) {
          if (+from >= +until) continue;
          const table = state.family === 'log' ? 'liekan_log' : 'website_event';
          const [proof] =
            overlap.row_count === 0n
              ? await tx.$queryRawUnsafe<{ empty: boolean }[]>(
                  `SELECT NOT EXISTS(SELECT 1 FROM ${table} WHERE website_id=$1::uuid AND created_at>=$2 AND created_at<$3 LIMIT 1) AS empty`,
                  fresh.website_id,
                  from,
                  until,
                )
              : [{ empty: false }];
          if (proof.empty) {
            await tx.$executeRawUnsafe(
              `INSERT INTO liekan_analysis_manifest(website_id,epoch,family,bucket,bucket_end,generation,previous_generation,build_id,fingerprint,versions,row_count,path_complete)
               VALUES($1::uuid,$2::bigint,$3,$4,$5,$6::uuid,$9::uuid,$8::uuid,liekan_analysis_fingerprint($1::uuid,$2::bigint,$3,$4,$5),$7::jsonb,0,true)`,
              fresh.website_id,
              String(fresh.epoch),
              state.family,
              from,
              until,
              overlap.generation,
              JSON.stringify(state.versions),
              overlap.build_id,
              overlap.previous_generation,
            );
          } else {
            await queueRecovery(
              tx,
              fresh.website_id,
              String(fresh.epoch),
              state.family,
              from,
              until,
              null,
              overlap.row_count === 0n ? 'empty-span-recovery' : 'overlap-recovery',
              overlap.build_id,
              fresh.id,
            );
          }
        }
      }
      const previous = overlaps.find(m => +m.bucket === +new Date(state.hour))?.generation || null;
      await tx.$executeRawUnsafe(
        `INSERT INTO liekan_analysis_manifest(website_id,epoch,family,bucket,bucket_end,generation,previous_generation,build_id,fingerprint,versions,row_count,path_complete)
         VALUES($1::uuid,$2::bigint,$3,$4::timestamptz,$5::timestamptz,$6::uuid,$7::uuid,$12::uuid,$8,$9::jsonb,$10::bigint,$11::boolean)`,
        fresh.website_id,
        String(fresh.epoch),
        state.family,
        state.hour,
        spanEnd,
        state.generation,
        previous,
        state.fingerprint,
        JSON.stringify(state.versions),
        state.rows,
        state.pathComplete !== false,
        fresh.id,
      );
      const units = analysisCompletedUnits(fresh, state.hour, spanEnd);
      const { complete, next } = advanceCheckpoint(fresh, state, spanEnd);
      await tx.$executeRawUnsafe(
        `UPDATE liekan_analysis_build SET checkpoint=$3::jsonb,work_done=CASE WHEN $5='completed' THEN work_total ELSE least(work_total,work_done+$4::bigint) END,status=$5,
         lease_token=NULL,lease_until=NULL,attempts=0,revision=revision+1,updated_at=clock_timestamp(),error_code=NULL
         WHERE id=$1::uuid AND lease_token=$2::uuid AND lease_until>clock_timestamp()`,
        fresh.id,
        fresh.lease_token,
        JSON.stringify(complete ? {} : next),
        units,
        complete ? 'completed' : 'queued',
      );
    }, 'RepeatableRead');
    await analysisTransaction(tx =>
      tx.$executeRawUnsafe(
        `UPDATE liekan_analysis_build SET lease_token=NULL,lease_until=NULL WHERE id=$1::uuid AND lease_token=$2::uuid`,
        row.id,
        row.lease_token,
      ),
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : 'analysis-work-failed';
    const capacity =
      code === 'analysis-capacity-limited' || code === 'analysis-visit-expansion-stopped';
    const collision = String((error as any)?.meta?.message || code).includes(
      'analysis-dimension-collision',
    );
    const invalid =
      code === 'analysis-epoch-changed' ||
      (error as any)?.status === 401 ||
      (error as any)?.status === 403 ||
      (error as any)?.status === 404;
    await analysisTransaction(tx =>
      tx.$executeRawUnsafe(
        `UPDATE liekan_analysis_build SET status=$3,attempts=attempts+1,error_code=$4,lease_token=NULL,lease_until=NULL,
       next_attempt_at=clock_timestamp()+($5::int*interval '1 second'),revision=revision+1,updated_at=clock_timestamp()
       WHERE id=$1::uuid AND lease_token=$2::uuid`,
        row.id,
        row.lease_token,
        capacity
          ? 'capacity_limited'
          : invalid
            ? 'invalidated'
            : row.attempts >= 3 || collision
              ? 'failed'
              : 'queued',
        capacity
          ? code === 'analysis-visit-expansion-stopped'
            ? code
            : 'analysis-capacity-limited'
          : invalid
            ? 'analysis-authority-changed'
            : collision
              ? 'analysis-dimension-collision'
              : 'analysis-work-failed',
        [5, 30, 120, 120][Math.min(row.attempts, 3)],
      ),
    );
    // Error details may contain SQL values. Only the stable public code is persisted.
  }
  return { worked: true, buildId: row.id };
}

/** A durable retained-history cursor waits for open hours and resumes failed deliveries. */
export async function bootstrapAnalysisHistory(now = Date.now(), websiteId?: string) {
  const sites = await analysisTransaction(tx =>
    tx.$queryRawUnsafe<any[]>(
      `SELECT s.* FROM liekan_analysis_site s JOIN website w USING(website_id)
       WHERE w.deleted_at IS NULL AND s.mode='live' AND (s.archive_epoch IS DISTINCT FROM s.epoch OR NOT s.archive_complete)
       AND ($1::uuid IS NULL OR s.website_id=$1::uuid)
       ORDER BY s.archive_checked_at NULLS FIRST,s.website_id LIMIT 8 FOR UPDATE OF s SKIP LOCKED`,
      websiteId || null,
    ),
  );
  let checked = 0;
  for (const candidate of sites) {
    // Discover source bounds before taking the authority row used by foreground admission.
    const boundary =
      String(candidate.archive_epoch) !== String(candidate.epoch)
        ? (
            await analysisTransaction(tx =>
              tx.$queryRawUnsafe<{ starts: Date | null; ends: Date | null }[]>(
                `SELECT min(at) AS starts,max(at) AS ends FROM (
                 (SELECT created_at AS at FROM website_event WHERE website_id=$1::uuid ORDER BY created_at LIMIT 1)
                 UNION ALL (SELECT created_at FROM website_event WHERE website_id=$1::uuid ORDER BY created_at DESC LIMIT 1)
                 UNION ALL (SELECT created_at FROM liekan_log WHERE website_id=$1::uuid ORDER BY created_at LIMIT 1)
                 UNION ALL (SELECT created_at FROM liekan_log WHERE website_id=$1::uuid ORDER BY created_at DESC LIMIT 1)) inputs`,
                candidate.website_id,
              ),
            )
          )[0]
        : undefined;
    checked += await analysisTransaction(async tx => {
      const [site] = await tx.$queryRawUnsafe<any[]>(
        `SELECT s.* FROM liekan_analysis_site s JOIN website w USING(website_id)
         WHERE s.website_id=$1::uuid AND s.epoch=$2::bigint AND s.mode='live' AND w.deleted_at IS NULL
         AND (s.archive_epoch IS DISTINCT FROM s.epoch OR NOT s.archive_complete)
         FOR UPDATE OF s SKIP LOCKED`,
        candidate.website_id,
        String(candidate.epoch),
      );
      if (!site || (String(site.archive_epoch) !== String(site.epoch) && !boundary)) return 0;
      await tx.$executeRawUnsafe(
        'UPDATE liekan_analysis_site SET archive_checked_at=clock_timestamp() WHERE website_id=$1::uuid',
        site.website_id,
      );
      if (String(site.archive_epoch) !== String(site.epoch)) {
        site.archive_next = boundary.starts
          ? new Date(Math.floor(+boundary.starts / 3600000) * 3600000)
          : null;
        site.archive_until = boundary.ends
          ? new Date((Math.floor(+boundary.ends / 3600000) + 1) * 3600000)
          : null;
        site.archive_build_id = null;
        await tx.$executeRawUnsafe(
          `UPDATE liekan_analysis_site SET archive_epoch=epoch,archive_next=$2,archive_until=$3,archive_build_id=NULL,archive_complete=$4 WHERE website_id=$1::uuid`,
          site.website_id,
          site.archive_next,
          site.archive_until,
          !boundary.starts,
        );
      }
      if (!site.archive_next || !site.archive_until) return 1;
      if (site.archive_build_id) {
        const [build] = await tx.$queryRawUnsafe<any[]>(
          'SELECT * FROM liekan_analysis_build WHERE id=$1::uuid',
          site.archive_build_id,
        );
        if (build && build.status !== 'completed') {
          if (
            ['failed', 'capacity_limited'].includes(build.status) &&
            +new Date(build.next_attempt_at) <= now
          )
            await tx.$executeRawUnsafe(
              `UPDATE liekan_analysis_build SET status='queued',attempts=0,next_attempt_at=clock_timestamp()+interval '5 minutes',error_code=NULL WHERE id=$1::uuid`,
              build.id,
            );
          return 1;
        }
        if (build) site.archive_next = build.range_end;
        await tx.$executeRawUnsafe(
          'UPDATE liekan_analysis_site SET archive_next=$2,archive_build_id=NULL WHERE website_id=$1::uuid',
          site.website_id,
          site.archive_next,
        );
      }
      if (+site.archive_next >= +site.archive_until) {
        await tx.$executeRawUnsafe(
          'UPDATE liekan_analysis_site SET archive_complete=true WHERE website_id=$1::uuid',
          site.website_id,
        );
        return 1;
      }
      const closed = new Date(Math.floor((now - 60000) / 3600000) * 3600000);
      const end = new Date(
        Math.min(+site.archive_until, +closed, +site.archive_next + 24 * 3600000),
      );
      if (+end <= +site.archive_next) return 1;
      const id = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO liekan_analysis_build(id,website_id,epoch,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total,automatic_history)
       VALUES($1::uuid,$2::uuid,$3::bigint,$4,$5,'UTC','zh-CN',$1::uuid,$6,'queued',$7::bigint,true)`,
        id,
        site.website_id,
        String(site.epoch),
        site.archive_next,
        end,
        analysisHash([
          'automatic-retained-history',
          site.website_id,
          String(site.epoch),
          site.archive_next.toISOString(),
          end.toISOString(),
        ]),
        Math.round((+end - +site.archive_next) / 3600000) * 2,
      );
      await tx.$executeRawUnsafe(
        'UPDATE liekan_analysis_site SET archive_build_id=$2::uuid WHERE website_id=$1::uuid',
        site.website_id,
        id,
      );
      return 1;
    });
  }
  return checked;
}

export async function reconcileAnalysisRollups(): Promise<{ queued: number }> {
  if (process.env.CLICKHOUSE_URL) return { queued: 0 };
  await analysisTransaction(async tx => {
    await tx.$executeRawUnsafe(`INSERT INTO liekan_analysis_site(website_id) SELECT w.website_id FROM website w
      WHERE w.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM liekan_analysis_site s WHERE s.website_id=w.website_id) ORDER BY w.website_id LIMIT 100 ON CONFLICT DO NOTHING`);
    await tx.$executeRawUnsafe(`UPDATE liekan_analysis_build b SET status='invalidated',error_code='analysis-epoch-changed',lease_token=NULL,lease_until=NULL,revision=b.revision+1
      FROM liekan_analysis_site s WHERE s.website_id=b.website_id AND (s.epoch<>b.epoch OR s.mode<>'live') AND b.status IN('queued','running','paused','failed','capacity_limited')`);
  });
  const recoveryAllowed = storageHistoryAllowed(
    await analysisTransaction(tx => analysisCapacity(tx, null)),
  );
  const { queued } = await discoverAnalysisRollups(
    (...args) => queueRecovery(...args, recoveryAllowed),
    recoveryAllowed,
  );
  await analysisTransaction(async tx => {
    await tx.$executeRawUnsafe(`DELETE FROM liekan_analysis_probe p WHERE (p.website_id,p.epoch,p.family,p.day) IN(
      SELECT f.website_id,f.epoch,f.family,f.day FROM liekan_analysis_probe f JOIN liekan_analysis_site s USING(website_id)
      WHERE f.epoch<>s.epoch AND s.updated_at<clock_timestamp()-interval '7 days' LIMIT 2000)`);
    await tx.$executeRawUnsafe(`DELETE FROM liekan_analysis_dirty d WHERE (d.website_id,d.epoch,d.family,d.bucket,d.shard) IN(
      SELECT f.website_id,f.epoch,f.family,f.bucket,f.shard FROM liekan_analysis_dirty f JOIN liekan_analysis_site s USING(website_id)
      WHERE f.epoch<>s.epoch AND s.updated_at<clock_timestamp()-interval '7 days' LIMIT 2000)`);
    await tx.$executeRawUnsafe(`DELETE FROM liekan_analysis_meter m WHERE bytes=0 AND NOT EXISTS(
      SELECT 1 FROM liekan_analysis_site s WHERE s.website_id=m.website_id AND s.epoch=m.epoch)`);
  });
  return { queued };
}
