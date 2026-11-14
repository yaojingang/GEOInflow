import { createHash } from 'node:crypto';
import type { LogStatistics } from './log-statistics';
import {
  analysisSafeNumber,
  type AnalysisLogInput,
  type AnalysisTx,
} from './analysis-rollups-model';
import { analysisTransaction } from './analysis-rollups-db';
import { currentCacheContext } from './cache-context';
import {
  chAi,
  chUnknown,
  ENGINE_TABLE,
  engineClient,
  engineConnection,
  engineQuery,
  engineWindow,
  HOUR,
} from './analytics-engine-clickhouse';
import { getQuerySnapshot } from './query-snapshot';

export const LOG_COUNTS_TABLE = 'liekan_log_counts_v1';
export const LOG_COUNTS_VERSION = 'liekan-log-counts-v2';
export const countKeys = [
  'requests',
  'ai',
  'abnormal',
  'legacyRequests',
  'unclassifiedRequests',
] as const;
export const countScopes = ['all', 'verified_range', 'verified_identity'] as const;
export type CountRow = { identity: string; classifications: string[] } & Record<
  (typeof countKeys)[number],
  string
>;
export const emptyCountRow = (identity: string): CountRow => ({
  identity,
  requests: '0',
  ai: '0',
  abnormal: '0',
  legacyRequests: '0',
  unclassifiedRequests: '0',
  classifications: [],
});
export function normalizeCounts(rows: CountRow[]): CountRow[] {
  if (rows.length !== 3 || new Set(rows.map(r => r.identity)).size !== 3)
    throw new Error('engine-counts-shape');
  return countScopes.map(identity => {
    const row = rows.find(r => r.identity === identity);
    if (
      !row ||
      !Array.isArray(row.classifications) ||
      row.classifications.some(v => typeof v !== 'string')
    )
      throw new Error('engine-counts-shape');
    const value = emptyCountRow(identity);
    for (const key of countKeys) {
      if (!/^\d+$/.test(String(row[key]))) throw new Error('engine-counts-number');
      value[key] = BigInt(row[key]).toString();
    }
    value.classifications = [...new Set(row.classifications)].sort();
    return value;
  });
}
export const countsDigest = (rows: CountRow[]) =>
  createHash('sha256')
    .update(JSON.stringify(normalizeCounts(rows)))
    .digest('hex');
export async function initializeCountsTable() {
  await engineClient().command({
    query: `CREATE TABLE IF NOT EXISTS ${LOG_COUNTS_TABLE} (
    installation_id UUID,source_epoch UInt64,website_id UUID,generation UUID,bucket DateTime64(3,'UTC'),
    family String,identity String,requests UInt64,ai UInt64,abnormal UInt64,legacyRequests UInt64,unclassifiedRequests UInt64,
    classifications Array(String),inserted_at DateTime64(3,'UTC') DEFAULT now64(3)
  ) ENGINE=MergeTree PARTITION BY toYYYYMM(bucket) ORDER BY (installation_id,website_id,bucket,generation,identity)`,
  });
}
export const countSelect = `identity,${countKeys.map(k => `toString(${k}) AS ${k}`).join(',')},classifications`;
export async function prepareCounts(
  params: Record<string, any>,
  expectedRawRows: string | number | bigint,
): Promise<string> {
  const scope = `installation_id={installation:UUID} AND website_id={site:UUID} AND bucket=parseDateTime64BestEffort({bucket:String},3) AND generation={generation:UUID}`;
  const read = () =>
    engineQuery<CountRow>(
      `SELECT ${countSelect} FROM ${LOG_COUNTS_TABLE} WHERE ${scope} AND family={family:String}`,
      { ...params, family: LOG_COUNTS_VERSION },
    );
  const metrics = countScopes.map(identity => {
    const eligible = `self_check=0${identity === 'verified_range' ? " AND verification='verified_range'" : identity === 'verified_identity' ? " AND verification IN ('verified_range','verified_dns','verified_edge')" : ''}`;
    return `tuple('${identity}',toString(countIf(${eligible})),toString(countIf(${eligible} AND (${chAi}))),
      toString(countIf(${eligible} AND status>=400)),toString(countIf(${eligible} AND isNull(ai_eligible))),
      toString(countIf(${eligible} AND (${chUnknown}))),groupUniqArrayIf(coalesce(classification_version,'legacy'),${eligible}))`;
  });
  const rows = await engineQuery<CountRow & { rawRows: string }>(
    `SELECT toString(raw_rows) AS rawRows,metric.1 AS identity,metric.2 AS requests,metric.3 AS ai,
      metric.4 AS abnormal,metric.5 AS legacyRequests,metric.6 AS unclassifiedRequests,metric.7 AS classifications
     FROM (SELECT count() AS raw_rows,[${metrics.join(',')}] AS metrics FROM ${ENGINE_TABLE} WHERE ${scope})
     ARRAY JOIN metrics AS metric`,
    params,
  );
  // Bind the statistics and the unfiltered source total to the same ClickHouse snapshot.
  if (rows.length !== 3 || rows.some(row => row.rawRows !== String(expectedRawRows)))
    throw new Error('engine-count-mismatch');
  const expected = normalizeCounts(rows);
  const digest = countsDigest(expected);
  let actual = await read();
  if (!actual.length) {
    await engineClient().insert({
      table: LOG_COUNTS_TABLE,
      format: 'JSONEachRow',
      values: expected.map(row => ({
        ...row,
        installation_id: params.installation,
        website_id: params.site,
        generation: params.generation,
        bucket: params.bucket,
        source_epoch: params.epoch,
        family: LOG_COUNTS_VERSION,
      })),
      clickhouse_settings: {
        date_time_input_format: 'best_effort',
        async_insert: 1,
        wait_for_async_insert: 1,
      },
    });
    actual = await read();
  }
  if (countsDigest(actual) !== digest) throw new Error('engine-counts-mismatch');
  return digest;
}

/** Private background computation consumes complete, independently proved UTC hours. */
export async function readClickHouseLogCounts(
  input: AnalysisLogInput,
): Promise<LogStatistics | null> {
  if (
    process.env.CLICKHOUSE_URL ||
    input.crawlerMetricsVersion !== 1 ||
    +input.startDate % HOUR ||
    +input.endDate % HOUR ||
    Object.values(input.filters || {}).some(v => v != null)
  )
    return null;
  const window = engineWindow(input);
  const identity = input.crawlerIdentityScope || 'all';
  if (!window || !countScopes.includes(identity as any)) return null;
  let config: ReturnType<typeof engineConnection>;
  try {
    config = engineConnection();
  } catch {
    return null;
  }
  if (!config) return null;
  const deadline = Math.min(Date.now() + 4000, currentCacheContext()?.deadline ?? Infinity);
  const work = async (tx: AnalysisTx): Promise<LogStatistics | null> => {
    const [state] = await tx.$queryRawUnsafe<any[]>(
      'SELECT enabled,epoch,healthy,connection_hash,installation_id FROM liekan_analytics_engine WHERE id=1',
    );
    if (!state?.enabled || !state.healthy || state.connection_hash !== config.key) return null;
    const { engineVersions } = await import('./analytics-engine');
    const versions = await engineVersions(tx, input.websiteId);
    if (!versions) return null;
    const [bounds] = await tx.$queryRawUnsafe<any[]>(
      `SELECT
      (SELECT created_at FROM liekan_log WHERE website_id=$1::uuid ORDER BY created_at LIMIT 1) AS first,
      (SELECT created_at FROM liekan_log WHERE website_id=$1::uuid ORDER BY created_at DESC LIMIT 1) AS last`,
      input.websiteId,
    );
    const first = new Date(
      Math.max(+window.first, Math.floor(+new Date(bounds.first) / HOUR) * HOUR),
    );
    const last = new Date(Math.min(+window.last, Math.floor(+new Date(bounds.last) / HOUR) * HOUR));
    const expected =
      bounds.first && bounds.last ? Math.max(0, Math.round((+last - +first) / HOUR) + 1) : 0;
    const units = await tx.$queryRawUnsafe<any[]>(
      `SELECT u.generation,u.counts_checksum FROM liekan_analytics_engine_unit u
      WHERE u.website_id=$1::uuid AND u.bucket>=$2 AND u.bucket<=$3 AND u.generation IS NOT NULL
      AND u.active_epoch=$4::bigint AND u.versions=$5::jsonb AND u.counts_version=$6 AND u.counts_verified_at IS NOT NULL AND u.counts_generation=u.generation
      AND u.fingerprint=liekan_engine_fingerprint(u.website_id,u.bucket) ORDER BY u.bucket`,
      input.websiteId,
      first,
      last,
      String(state.epoch),
      JSON.stringify(versions),
      LOG_COUNTS_VERSION,
    );
    if (units.length !== expected) return null;
    const total = emptyCountRow(identity),
      classifications = new Set<string>();
    try {
      // At most 1,536 compact rows per request, including the independent proof for each scope.
      for (let at = 0; at < units.length; at += 512) {
        if (Date.now() >= deadline) return null;
        const batch = units.slice(at, at + 512);
        const rows = await engineQuery<CountRow & { generation: string }>(
          `SELECT generation,${countSelect} FROM ${LOG_COUNTS_TABLE} WHERE installation_id={installation:UUID} AND website_id={site:UUID} AND family={family:String} AND generation IN {generations:Array(UUID)}`,
          {
            installation: state.installation_id,
            site: input.websiteId,
            family: LOG_COUNTS_VERSION,
            generations: batch.map(u => u.generation),
          },
          deadline,
        );
        const invalid = batch.filter(unit => {
          try {
            return (
              countsDigest(rows.filter(r => r.generation === unit.generation)) !==
              unit.counts_checksum
            );
          } catch {
            return true;
          }
        });
        if (invalid.length) {
          await analysisTransaction(t =>
            t.$executeRawUnsafe(
              `UPDATE liekan_analytics_engine_unit SET counts_verified_at=NULL,attempts=0,retry_at=NULL,error_code='engine-counts-lost' WHERE website_id=$1::uuid AND generation=ANY($2::uuid[])`,
              input.websiteId,
              invalid.map(u => u.generation),
            ),
          );
          return null;
        }
        for (const unit of batch) {
          const actual = rows.filter(r => r.generation === unit.generation);
          const row = actual.find(r => r.identity === identity)!;
          for (const key of countKeys)
            total[key] = (BigInt(total[key]) + BigInt(row[key])).toString();
          for (const version of row.classifications) classifications.add(version);
        }
      }
      if (Date.now() >= deadline) return null;
      return {
        ...Object.fromEntries(countKeys.map(k => [k, analysisSafeNumber(total[k])])),
        classifications: [...classifications].sort(),
      } as LogStatistics;
    } catch (error) {
      if (String((error as { code?: unknown })?.code) === '60' && units.length) {
        await analysisTransaction(t =>
          t.$executeRawUnsafe(
            `UPDATE liekan_analytics_engine_unit SET counts_verified_at=NULL,attempts=0,retry_at=NULL,error_code='engine-counts-lost' WHERE website_id=$1::uuid AND generation=ANY($2::uuid[])`,
            input.websiteId,
            units.map(u => u.generation),
          ),
        ).catch(() => {});
      }
      // A missing or altered service table never supplies an unproved zero or partial result.
      return null;
    }
  };
  const snapshot = getQuerySnapshot();
  return snapshot ? work(snapshot as AnalysisTx) : analysisTransaction(work, 'RepeatableRead');
}
