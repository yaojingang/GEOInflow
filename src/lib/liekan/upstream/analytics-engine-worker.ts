import { createHash, randomUUID } from 'node:crypto';
import { withAnalysisPermit } from './analysis-background';
import { analysisPermitTable, currentAnalysisPermit } from './analysis-permit-context';
import { analysisTransaction } from './analysis-rollups-db';
import type { AnalysisTx } from './analysis-rollups-model';
import { engineAdmin, engineVersions } from './analytics-engine';
import {
  ENGINE_TABLE,
  engineClient,
  engineConnection,
  engineQuery,
  engineValueKey,
  HOUR,
  type Projection,
  projectionColumns,
  projectionDigest,
} from './analytics-engine-clickhouse';
import { LiekanError } from './errors';

const owner = randomUUID();
const columns = projectionColumns.join(',');
const utcHour = (field: string) => `date_bin(interval '1 hour',${field},timestamptz '2000-01-01Z')`;
const projectionSql = `SELECT l.id,to_char(l.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,l.path,
 l.status,l.bot,l.vendor,l.bot_type,l.verification,CASE WHEN l.ai_eligible IS NULL THEN NULL WHEN l.ai_eligible THEN 1 ELSE 0 END AS ai_eligible,
 l.recognition_state,l.reporting_crawler_id AS crawler_id,l.reporting_catalog_version::text AS catalog_version,
 l.reporting_classification_version AS classification_version,
 (SELECT identity->>'productForm' FROM liekan_crawler_registry_version v
  CROSS JOIN LATERAL jsonb_array_elements(v.payload->'identities') identity
  WHERE v.version=l.reporting_catalog_version AND identity->>'id'=l.reporting_crawler_id LIMIT 1) AS product_form,
 CASE WHEN l.user_agent LIKE 'Liekan-Crawler-Check/%' THEN 1 ELSE 0 END AS self_check
 FROM liekan_reporting_log l WHERE l.website_id=$1::uuid AND l.created_at>=$2::timestamptz
 AND l.created_at<$2::timestamptz+interval '1 hour'`;
function normalizeProjection(row: any): Projection {
  const result: any = {};
  for (const key of projectionColumns) result[key] = row[key];
  result.created_at = String(row.created_at).replace(
    /\.(\d{1,6})Z$/,
    (_, d) => `.${d.padEnd(6, '0')}Z`,
  );
  return result;
}
async function stateForWork(tx: AnalysisTx, lock = 'FOR UPDATE SKIP LOCKED') {
  const [state] = await tx.$queryRawUnsafe<any[]>(
    `SELECT * FROM liekan_analytics_engine WHERE id=1 ${lock}`,
  );
  const config = engineConnection();
  return state?.capture && config?.key === state.connection_hash ? state : null;
}
let discoveredAt = 0;
export async function discoverEngineWork(force = false) {
  if (!force && Date.now() - discoveredAt < 5000) return;
  await analysisTransaction(async tx => {
    const state = await stateForWork(tx);
    if (!state) return;
    await tx.$executeRawUnsafe(
      'UPDATE liekan_analytics_engine SET worker_at=clock_timestamp() WHERE id=1',
    );
    if (!state.syncing) return;
    try {
      await engineAdmin(tx, state.actor_id);
    } catch (error) {
      if (!(error instanceof LiekanError) || error.status !== 403) throw error;
      await tx.$executeRawUnsafe(
        "UPDATE liekan_analytics_engine SET syncing=false,enabled=false,error_code='engine-admin-required',revision=revision+1 WHERE id=1",
      );
      return;
    }
    const closed = new Date(Math.floor((Date.now() - 30000) / HOUR) * HOUR);
    const sites = await tx.$queryRawUnsafe<
      any[]
    >(`SELECT s.* FROM liekan_analytics_engine_site s JOIN website w USING(website_id)
   WHERE w.deleted_at IS NULL AND NOT s.purge_pending ORDER BY s.discovered_at NULLS FIRST,s.website_id LIMIT 8 FOR NO KEY UPDATE OF s SKIP LOCKED`);
    for (const site of sites) {
      const [last] = await tx.$queryRawUnsafe<any[]>(
        `SELECT bucket FROM liekan_analytics_engine_dirty WHERE website_id=$1::uuid ORDER BY bucket DESC LIMIT 1`,
        site.website_id,
      );
      const versions = await engineVersions(tx, site.website_id);
      if (
        String(site.control_epoch) !== String(state.epoch) ||
        engineValueKey(site.seen_versions) !== engineValueKey(versions)
      ) {
        await tx.$executeRawUnsafe(
          'UPDATE liekan_analytics_engine_unit SET verified_at=NULL WHERE website_id=$1::uuid',
          site.website_id,
        );
        await tx.$executeRawUnsafe(
          'UPDATE liekan_analytics_engine_site SET seen_versions=$2::jsonb,control_epoch=$3::bigint WHERE website_id=$1::uuid',
          site.website_id,
          JSON.stringify(versions),
          String(state.epoch),
        );
      }
      const end = new Date(
        Math.min(
          +closed,
          Math.max(
            +(site.history_end || 0),
            last ? Math.floor(+new Date(last.bucket) / HOUR) * HOUR + HOUR : 0,
          ),
        ),
      );
      const start = site.history_cursor || site.history_start;
      if (start && +new Date(start) < +end) {
        const until = new Date(Math.min(+end, +new Date(start) + 256 * HOUR));
        await tx.$executeRawUnsafe(
          `INSERT INTO liekan_analytics_engine_unit(website_id,bucket)
     SELECT $1::uuid,at FROM generate_series($2::timestamptz,$3::timestamptz-interval '1 hour',interval '1 hour') g(at) ON CONFLICT DO NOTHING`,
          site.website_id,
          start,
          until,
        );
        await tx.$executeRawUnsafe(
          'UPDATE liekan_analytics_engine_site SET history_cursor=$2 WHERE website_id=$1::uuid',
          site.website_id,
          until,
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE liekan_analytics_engine_site SET history_end=$2,discovered_at=clock_timestamp() WHERE website_id=$1::uuid',
        site.website_id,
        end,
      );
    }
    const markers = await tx.$queryRawUnsafe<any[]>(
      `SELECT website_id,bucket,shard FROM liekan_analytics_engine_dirty
   WHERE pending AND bucket<$1 AND website_id=ANY($2::uuid[]) ORDER BY bucket,website_id,shard LIMIT 128 FOR UPDATE SKIP LOCKED`,
      closed,
      sites.map(site => site.website_id),
    );
    const hours = new Map<string, { site: string; bucket: Date }>();
    for (const marker of markers)
      hours.set(marker.website_id + Math.floor(+new Date(marker.bucket) / HOUR), {
        site: marker.website_id,
        bucket: new Date(Math.floor(+new Date(marker.bucket) / HOUR) * HOUR),
      });
    for (const hour of hours.values()) {
      await tx.$executeRawUnsafe(
        `UPDATE liekan_analytics_engine_site SET history_start=least(history_start,$2),history_cursor=CASE WHEN history_start IS NULL OR $2<history_start THEN least(history_cursor,$2) ELSE history_cursor END,history_end=greatest(history_end,$2::timestamptz+interval '1 hour') WHERE website_id=$1::uuid`,
        hour.site,
        hour.bucket,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO liekan_analytics_engine_unit(website_id,bucket) VALUES($1::uuid,$2)
    ON CONFLICT(website_id,bucket) DO UPDATE SET verified_at=CASE WHEN liekan_analytics_engine_unit.fingerprint=liekan_engine_fingerprint($1::uuid,$2) THEN liekan_analytics_engine_unit.verified_at ELSE NULL END`,
        hour.site,
        hour.bucket,
      );
    }
    for (const marker of markers)
      await tx.$executeRawUnsafe(
        'UPDATE liekan_analytics_engine_dirty SET pending=false WHERE website_id=$1::uuid AND bucket=$2 AND shard=$3',
        marker.website_id,
        marker.bucket,
        marker.shard,
      );
  });
  discoveredAt = Date.now();
}
async function claim() {
  return analysisTransaction(async tx => {
    const state = await stateForWork(tx);
    if (!state) return null;
    await tx.$executeRawUnsafe(
      'UPDATE liekan_analytics_engine SET maintenance_turn=(maintenance_turn+1)%8 WHERE id=1',
    );
    const [purge] = await tx.$queryRawUnsafe<any[]>(
      `SELECT * FROM liekan_analytics_engine_site WHERE ((purge_pending AND $1=ANY(pending_targets)) OR ($2::boolean AND purge_through>0 AND $1=ANY(sweep_targets) AND (purge_checked_at IS NULL OR purge_checked_at<clock_timestamp()-interval '30 seconds')))
   AND (purge_until IS NULL OR purge_until<clock_timestamp()) ORDER BY purge_pending DESC,purge_checked_at NULLS FIRST,website_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      state.connection_hash,
      !state.syncing || Number(state.maintenance_turn) === 0,
    );
    if (purge) {
      const token = randomUUID();
      await tx.$executeRawUnsafe(
        "UPDATE liekan_analytics_engine_site SET purge_token=$2::uuid,purge_until=clock_timestamp()+interval '90 seconds' WHERE website_id=$1::uuid",
        purge.website_id,
        token,
      );
      return { kind: 'purge' as const, state, site: purge, token };
    }
    if (!state.syncing || !state.actor_id) return null;
    await engineAdmin(tx, state.actor_id);
    const closed = new Date(Math.floor((Date.now() - 30000) / HOUR) * HOUR);
    const [unit] = await tx.$queryRawUnsafe<any[]>(
      `SELECT u.* FROM liekan_analytics_engine_unit u
   JOIN liekan_analytics_engine_site s USING(website_id) JOIN website w USING(website_id)
   WHERE w.deleted_at IS NULL AND NOT s.purge_pending AND u.bucket<$1
   AND (u.lease_token=$2::uuid OR u.lease_until IS NULL OR u.lease_until<clock_timestamp())
   AND (u.retry_at IS NULL OR u.retry_at<=clock_timestamp()) AND u.attempts<4
   AND (u.candidate IS NOT NULL OR u.generation IS NULL OR u.verified_at IS NULL)
   ORDER BY s.served_at NULLS FIRST,(u.candidate IS NOT NULL) DESC,u.bucket,u.website_id LIMIT 1 FOR UPDATE OF u SKIP LOCKED`,
      closed,
      owner,
    );
    if (!unit) return null;
    const versions = await engineVersions(tx, unit.website_id);
    const [source] = await tx.$queryRawUnsafe<any[]>(
      'SELECT liekan_engine_fingerprint($1::uuid,$2::timestamptz) AS fingerprint',
      unit.website_id,
      unit.bucket,
    );
    if (
      !unit.candidate ||
      unit.lease_token !== owner ||
      String(unit.candidate_control_revision) !== String(state.revision) ||
      unit.candidate_fingerprint !== source.fingerprint ||
      engineValueKey(unit.candidate_versions) !== engineValueKey(versions)
    ) {
      if (unit.candidate)
        await tx.$executeRawUnsafe(
          'UPDATE liekan_analytics_engine_generation SET retired_at=clock_timestamp() WHERE id=$1::uuid',
          unit.candidate,
        );
      unit.candidate = randomUUID();
      unit.cursor_time = null;
      unit.cursor_id = null;
      unit.copied = 0;
      unit.chunk = 0;
      unit.candidate_checksum = '';
      await tx.$executeRawUnsafe(
        'INSERT INTO liekan_analytics_engine_generation(id,website_id) VALUES($1::uuid,$2::uuid)',
        unit.candidate,
        unit.website_id,
      );
      await tx.$executeRawUnsafe(
        `UPDATE liekan_analytics_engine_unit SET candidate=$3::uuid,candidate_versions=$4::jsonb,
    candidate_fingerprint=$5,candidate_epoch=$6::bigint,candidate_control_revision=$7::bigint,
    cursor_time=NULL,cursor_id=NULL,copied=0,chunk=0,candidate_checksum='' WHERE website_id=$1::uuid AND bucket=$2`,
        unit.website_id,
        unit.bucket,
        unit.candidate,
        JSON.stringify(versions),
        source.fingerprint,
        String(state.epoch),
        String(state.revision),
      );
    }
    await tx.$executeRawUnsafe(
      "UPDATE liekan_analytics_engine_unit SET lease_token=$3::uuid,lease_until=clock_timestamp()+interval '90 seconds' WHERE website_id=$1::uuid AND bucket=$2",
      unit.website_id,
      unit.bucket,
      owner,
    );
    await tx.$executeRawUnsafe(
      'UPDATE liekan_analytics_engine_site SET served_at=clock_timestamp(),targets=CASE WHEN $2=ANY(targets) THEN targets ELSE array_append(targets,$2) END WHERE website_id=$1::uuid',
      unit.website_id,
      state.connection_hash,
    );
    return { kind: 'unit' as const, state, unit, versions, fingerprint: source.fingerprint };
  });
}
async function recordFailure(work: NonNullable<Awaited<ReturnType<typeof claim>>>) {
  await analysisTransaction(async tx => {
    if (work.kind === 'purge') {
      await tx.$executeRawUnsafe(
        "UPDATE liekan_analytics_engine_site SET purge_until=clock_timestamp()+interval '30 seconds' WHERE website_id=$1::uuid AND purge_token=$2::uuid",
        work.site.website_id,
        work.token,
      );
    } else {
      await tx.$executeRawUnsafe(
        `UPDATE liekan_analytics_engine_unit SET attempts=attempts+1,error_code='engine-sync-failed',
    retry_at=clock_timestamp()+CASE WHEN attempts=0 THEN interval '5 seconds' WHEN attempts=1 THEN interval '30 seconds' ELSE interval '120 seconds' END,
    lease_until=clock_timestamp(),lease_token=NULL WHERE website_id=$1::uuid AND bucket=$2 AND candidate=$3::uuid AND lease_token=$4::uuid`,
        work.unit.website_id,
        work.unit.bucket,
        work.unit.candidate,
        owner,
      );
    }
    await tx.$executeRawUnsafe(
      "UPDATE liekan_analytics_engine SET error_code='engine-sync-failed' WHERE id=1",
    );
  });
}
export async function runEngineBatch(): Promise<boolean> {
  if (!engineConnection() || process.env.CLICKHOUSE_URL) return false;
  await discoverEngineWork();
  const work = await claim();
  if (!work) return false;
  try {
    if (work.kind === 'purge') {
      await engineClient().command({
        query: `ALTER TABLE ${ENGINE_TABLE} DELETE WHERE installation_id={installation:UUID}
    AND website_id={site:UUID} AND source_epoch<{epoch:UInt64}`,
        query_params: {
          installation: work.state.installation_id,
          site: work.site.website_id,
          epoch: String(work.site.purge_through),
        },
        clickhouse_settings: { mutations_sync: '1' },
      });
      await analysisTransaction(async tx => {
        const state = await stateForWork(tx);
        if (!state || state.connection_hash !== work.state.connection_hash) return;
        const [site] = await tx.$queryRawUnsafe<any[]>(
          'SELECT * FROM liekan_analytics_engine_site WHERE website_id=$1::uuid AND purge_until>clock_timestamp() FOR UPDATE',
          work.site.website_id,
        );
        if (
          !site ||
          site.purge_token !== work.token ||
          String(site.epoch) !== String(work.site.epoch)
        )
          return;
        if (!site.purge_pending) {
          await tx.$executeRawUnsafe(
            'UPDATE liekan_analytics_engine_site SET purge_checked_at=clock_timestamp(),purge_token=NULL,purge_until=NULL WHERE website_id=$1::uuid',
            site.website_id,
          );
          return;
        }
        await tx.$executeRawUnsafe(
          'DELETE FROM liekan_analytics_engine_unit WHERE website_id=$1::uuid',
          site.website_id,
        );
        await tx.$executeRawUnsafe(
          'DELETE FROM liekan_analytics_engine_dirty WHERE website_id=$1::uuid',
          site.website_id,
        );
        await tx.$executeRawUnsafe(
          'DELETE FROM liekan_analytics_engine_generation WHERE website_id=$1::uuid',
          site.website_id,
        );
        await tx.$executeRawUnsafe(
          `UPDATE liekan_analytics_engine_site SET pending_targets=array_remove(pending_targets,$2),targets=array_remove(targets,$2),purge_pending=cardinality(array_remove(pending_targets,$2))>0,purge_checked_at=clock_timestamp(),purge_token=NULL,purge_until=NULL,
     history_cursor=(SELECT ${utcHour('min(created_at)')} FROM liekan_log WHERE website_id=$1::uuid),
     history_start=(SELECT ${utcHour('min(created_at)')} FROM liekan_log WHERE website_id=$1::uuid),
     history_end=(SELECT ${utcHour('max(created_at)')}+interval '1 hour' FROM liekan_log WHERE website_id=$1::uuid)
     WHERE website_id=$1::uuid`,
          site.website_id,
          work.state.connection_hash,
        );
      });
      return true;
    }
    const { unit, state, versions, fingerprint } = work;
    const rows = await analysisTransaction(async tx =>
      (
        await tx.$queryRawUnsafe<any[]>(
          `${projectionSql}
   ${unit.cursor_time ? 'AND (l.created_at,l.id)>($3::timestamptz,$4::text)' : ''}
   ORDER BY l.created_at,l.id LIMIT 2000`,
          unit.website_id,
          unit.bucket,
          ...(unit.cursor_time ? [unit.cursor_time, unit.cursor_id] : []),
        )
      ).map(normalizeProjection),
    );
    if (rows.length) {
      const readChunk = async () =>
        (
          await engineQuery(
            `SELECT ${columns} FROM ${ENGINE_TABLE} WHERE installation_id={installation:UUID}
    AND website_id={site:UUID} AND bucket=parseDateTime64BestEffort({bucket:String},3)
    AND generation={generation:UUID} AND chunk={chunk:UInt32} ORDER BY created_at,id`,
            {
              installation: state.installation_id,
              site: unit.website_id,
              generation: unit.candidate,
              bucket: new Date(unit.bucket).toISOString(),
              chunk: unit.chunk,
            },
          )
        ).map(normalizeProjection);
      let copied = await readChunk();
      if (!copied.length) {
        await engineClient().insert({
          table: ENGINE_TABLE,
          format: 'JSONEachRow',
          values: rows.map(row => ({
            ...row,
            installation_id: state.installation_id,
            source_epoch: String(versions.siteEpoch),
            website_id: unit.website_id,
            generation: unit.candidate,
            bucket: new Date(unit.bucket).toISOString(),
            chunk: unit.chunk,
          })),
          clickhouse_settings: {
            date_time_input_format: 'best_effort',
            async_insert: 1,
            wait_for_async_insert: 1,
          },
        });
      }
      if (!copied.length) copied = await readChunk();
      if (copied.length !== rows.length || projectionDigest(copied) !== projectionDigest(rows))
        throw new Error('engine-copy-mismatch');
    } else {
      const [count] = await engineQuery(
        `SELECT count() AS count FROM ${ENGINE_TABLE} WHERE installation_id={installation:UUID}
    AND website_id={site:UUID} AND bucket=parseDateTime64BestEffort({bucket:String},3) AND generation={generation:UUID}`,
        {
          installation: state.installation_id,
          site: unit.website_id,
          generation: unit.candidate,
          bucket: new Date(unit.bucket).toISOString(),
        },
      );
      if (String(count.count) !== String(unit.copied)) throw new Error('engine-count-mismatch');
    }
    // No external I/O runs while publication holds source or authority locks.
    await analysisTransaction(async tx => {
      const permit = currentAnalysisPermit();
      if (permit) {
        const [lease] = await tx.$queryRawUnsafe<any[]>(
          `SELECT 1 FROM ${analysisPermitTable(permit)} WHERE token=$1::uuid AND epoch=$2::bigint AND lease_until>clock_timestamp() FOR SHARE`,
          permit.token,
          permit.epoch,
        );
        if (!lease) return;
      }
      const currentState = await stateForWork(tx, 'FOR SHARE');
      if (!currentState?.syncing || String(currentState.revision) !== String(state.revision))
        return;
      await engineAdmin(tx, currentState.actor_id);
      const [site] = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM liekan_analytics_engine_site WHERE website_id=$1::uuid FOR SHARE',
        unit.website_id,
      );
      if (!site || site.purge_pending) return;
      if (!rows.length)
        await tx.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text||extract(epoch FROM $2::timestamptz)::bigint::text,57001))',
          unit.website_id,
          unit.bucket,
        );
      const [currentUnit] = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM liekan_analytics_engine_unit WHERE website_id=$1::uuid AND bucket=$2 AND lease_until>clock_timestamp() FOR UPDATE',
        unit.website_id,
        unit.bucket,
      );
      if (
        currentUnit?.candidate !== unit.candidate ||
        currentUnit.lease_token !== owner ||
        String(currentUnit.chunk) !== String(unit.chunk)
      )
        return;
      const current = await engineVersions(tx, unit.website_id);
      const [source] = await tx.$queryRawUnsafe<any[]>(
        'SELECT liekan_engine_fingerprint($1::uuid,$2::timestamptz) AS fingerprint',
        unit.website_id,
        unit.bucket,
      );
      if (
        engineValueKey(current) !== engineValueKey(versions) ||
        source.fingerprint !== fingerprint
      )
        return;
      if (rows.length) {
        const last = rows.at(-1),
          digest = createHash('sha256')
            .update((unit.candidate_checksum || '') + projectionDigest(rows))
            .digest('hex');
        await tx.$executeRawUnsafe(
          `UPDATE liekan_analytics_engine_unit SET cursor_time=$3,cursor_id=$4,copied=copied+$5::bigint,
     chunk=chunk+1,candidate_checksum=$6,lease_until=clock_timestamp()+interval '90 seconds'
     WHERE website_id=$1::uuid AND bucket=$2`,
          unit.website_id,
          unit.bucket,
          last.created_at,
          last.id,
          rows.length,
          digest,
        );
      } else {
        if (unit.generation)
          await tx.$executeRawUnsafe(
            'UPDATE liekan_analytics_engine_generation SET retired_at=clock_timestamp() WHERE id=$1::uuid',
            unit.generation,
          );
        await tx.$executeRawUnsafe(
          `UPDATE liekan_analytics_engine_unit SET generation=candidate,active_epoch=candidate_epoch,
     versions=candidate_versions,fingerprint=candidate_fingerprint,row_count=copied,checksum=candidate_checksum,
     published_at=clock_timestamp(),verified_at=clock_timestamp(),candidate=NULL,lease_token=NULL,lease_until=NULL,
     attempts=0,error_code=NULL,retry_at=NULL WHERE website_id=$1::uuid AND bucket=$2`,
          unit.website_id,
          unit.bucket,
        );
      }
    });
    return true;
  } catch (error) {
    await recordFailure(work);
    throw error;
  }
}

let running = false,
  collectedAt = 0,
  healthAt = 0;
async function checkHealth() {
  if (Date.now() - healthAt < 30000) return;
  const state = await analysisTransaction(tx => stateForWork(tx, ''));
  if (!state) return;
  try {
    await engineQuery('SELECT 1 AS ready');
    await analysisTransaction(tx =>
      tx.$executeRawUnsafe(
        'UPDATE liekan_analytics_engine SET healthy=true,worker_at=clock_timestamp(),error_code=CASE WHEN EXISTS(SELECT 1 FROM liekan_analytics_engine_unit WHERE error_code IS NOT NULL) THEN error_code ELSE NULL END WHERE id=1 AND connection_hash=$1',
        state.connection_hash,
      ),
    );
  } catch {
    await analysisTransaction(tx =>
      tx.$executeRawUnsafe(
        "UPDATE liekan_analytics_engine SET healthy=false,error_code='engine-connection-failed',worker_at=clock_timestamp() WHERE id=1 AND connection_hash=$1",
        state.connection_hash,
      ),
    );
  }
  healthAt = Date.now();
}
export async function collectEngineGarbage() {
  const state = await analysisTransaction(tx => stateForWork(tx, ''));
  if (!state) return;
  // Query parameters use multipart. Mutations have a bounded list and stay below URL limits.
  const candidates = await engineQuery<{ generation: string }>(
    `SELECT generation FROM ${ENGINE_TABLE}
  WHERE installation_id={installation:UUID} AND generation>{cursor:UUID}
  GROUP BY generation HAVING max(inserted_at)<now()-INTERVAL 7 DAY
  ORDER BY generation LIMIT 1000`,
    {
      installation: state.installation_id,
      cursor: state.gc_cursor || '00000000-0000-0000-0000-000000000000',
    },
  );
  const protectedRows = await analysisTransaction(tx =>
    tx.$queryRawUnsafe<any[]>(
      `SELECT id FROM liekan_analytics_engine_generation
  WHERE id=ANY($1::uuid[]) AND (retired_at IS NULL OR retired_at>clock_timestamp()-interval '7 days')`,
      candidates.map(g => g.generation),
    ),
  );
  const protectedIds = new Set(protectedRows.map(g => g.id));
  const retired = candidates
    .filter(g => !protectedIds.has(g.generation))
    .slice(0, 50)
    .map(g => g.generation);
  if (retired.length)
    await engineClient().command({
      query: `ALTER TABLE ${ENGINE_TABLE} DELETE WHERE installation_id={installation:UUID}
  AND generation IN {generations:Array(UUID)}`,
      query_params: { installation: state.installation_id, generations: retired },
      clickhouse_settings: { mutations_sync: '1' },
    });
  await analysisTransaction(async tx => {
    await tx.$executeRawUnsafe(
      "DELETE FROM liekan_analytics_engine_generation WHERE id=ANY($1::uuid[]) AND retired_at<clock_timestamp()-interval '7 days'",
      retired,
    );
    await tx.$executeRawUnsafe(
      'UPDATE liekan_analytics_engine SET gc_cursor=$1::uuid WHERE id=1 AND connection_hash=$2',
      candidates.length === 1000 ? candidates.at(-1).generation : null,
      state.connection_hash,
    );
  });
}
export async function pumpAnalyticsEngine() {
  if (running || !engineConnection() || process.env.CLICKHOUSE_URL) return;
  running = true;
  try {
    await checkHealth();
    await withAnalysisPermit('history', async owned => {
      if (Date.now() - collectedAt > 300000) {
        await collectEngineGarbage();
        collectedAt = Date.now();
      }
      const until = Date.now() + 2000;
      for (let i = 0; i < 64 && owned() && Date.now() < until; i++)
        if (!(await runEngineBatch())) break;
    });
  } finally {
    running = false;
  }
}
