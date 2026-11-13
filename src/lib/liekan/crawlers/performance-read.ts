import { evidenceValue } from '../contracts/crawler-metrics';
import { type EvidenceQuery, performanceQuerySchema } from '../contracts/traffic-evidence';
import type { AiTx } from '../upstream/ai-db';
import { LiekanError } from '../upstream/errors';
import { warehousePerformanceFacts } from '../upstream/warehouse-evidence-queries';
import { warehouseEvidenceSections } from '../upstream/warehouse-evidence-table';
import { warehouseEnabled } from '../warehouse/authority-routing';
import {
  type EvidenceInputs,
  evidenceMeta,
  evidenceScope,
  parseEvidenceQuery,
} from './evidence-read';

export function parsePerformanceQuery(value: unknown) {
  const parsed = performanceQuerySchema.safeParse(value);
  if (!parsed.success) throw new LiekanError('请选择一个日志来源后读取统计。', 400);
  return parseEvidenceQuery(parsed.data) as EvidenceQuery;
}
const knownCache = [
  'miss',
  'expired',
  'updating',
  'stale',
  'hit',
  'ignored',
  'bypass',
  'revalidated',
  'dynamic',
  'stream_hit',
  'deferred',
];
export async function readPerformance(
  tx: AiTx,
  websiteId: string,
  p: EvidenceQuery,
  input: EvidenceInputs,
) {
  const scope = evidenceScope(websiteId, p);
  const projection = `SELECT l.created_at,l.bytes,e.measurement,lower(e.cache_status) AS cache,
    e.edge_observation,
    CASE WHEN e.edge_observation->'fields'->'edgeDurationMs'->>'state'='present' THEN (e.edge_observation->'fields'->'edgeDurationMs'->>'value')::float8 ELSE e.duration_ms END AS edge_ms,
    CASE WHEN e.edge_observation->'fields'->'OriginResponseDurationMs'->>'state'='present'
      AND (e.edge_observation->'fields'->'OriginResponseStatus'->>'value')::int BETWEEN 100 AND 599
      THEN (e.edge_observation->'fields'->'OriginResponseDurationMs'->>'value')::float8 END AS origin_ms ${scope.sql}`;
  const warehouseFacts = warehouseEnabled()
    ? await warehousePerformanceFacts(websiteId, p, knownCache)
    : null;
  const [totals] = warehouseFacts
    ? [warehouseFacts.totals]
    : await tx.query(
        `WITH selected AS (${projection}) SELECT count(*)::float8 AS requests,
    count(edge_ms)::float8 AS "edgeSamples",percentile_cont(0.5) WITHIN GROUP(ORDER BY edge_ms) AS "edgeP50",percentile_cont(0.95) WITHIN GROUP(ORDER BY edge_ms) AS "edgeP95",
    count(origin_ms)::float8 AS "originSamples",percentile_cont(0.5) WITHIN GROUP(ORDER BY origin_ms) AS "originP50",percentile_cont(0.95) WITHIN GROUP(ORDER BY origin_ms) AS "originP95",
    count(*) FILTER(WHERE edge_observation->'fields'->'edgeDurationMs'->>'reason'='over_limit')::float8 AS "edgeOverLimit",
    count(*) FILTER(WHERE edge_observation->'fields'->'OriginResponseDurationMs'->>'reason'='over_limit')::float8 AS "originOverLimit",
    count(*) FILTER(WHERE edge_observation->'fields'->'OriginResponseStatus'->>'value'='0')::float8 AS "unattributedOrigin",
    count(*) FILTER(WHERE cache=ANY($${scope.args.length + 1}::text[]))::float8 AS "cacheSamples",
    count(*) FILTER(WHERE cache IN('hit','stream_hit'))::float8 AS hits
    FROM selected`,
        ...scope.args,
        knownCache,
      );
  const rows = warehouseFacts
    ? warehouseFacts.rows
    : await tx.query(
        `WITH selected AS (${projection}), bytes AS (
    SELECT coalesce(measurement->>'bytesUnit','unknown') AS unit,
      count(*)::float8 AS requests,count(*) FILTER(WHERE measurement->>'bytesAvailability'='present')::float8 AS samples,
      sum(bytes::numeric) FILTER(WHERE measurement->>'bytesAvailability'='present')::text AS "observedBytes"
    FROM selected GROUP BY 1), minutes AS (
    SELECT coalesce(measurement->>'bytesUnit','unknown') AS unit,date_bin(interval '60 seconds',created_at,'2000-01-01Z'::timestamptz) AS minute,
      sum(bytes::numeric) FILTER(WHERE measurement->>'bytesAvailability'='present') AS bytes
    FROM selected GROUP BY 1,2)
    SELECT b.*,max(m.bytes) FILTER(WHERE m.minute>=$2 AND m.minute+interval '60 seconds'<=$3)::text AS "peakMinuteBytes",
      (max(m.bytes) FILTER(WHERE m.minute>=$2 AND m.minute+interval '60 seconds'<=$3)/60)::text AS "observedPeakBytesPerSecond"
    FROM bytes b LEFT JOIN minutes m USING(unit) GROUP BY b.unit,b.requests,b.samples,b."observedBytes" ORDER BY b.unit`,
        ...scope.args,
      );
  const [peak] = warehouseFacts
    ? [warehouseFacts.peak]
    : await tx.query(
        `WITH minutes AS (SELECT date_bin(interval '60 seconds',l.created_at,'2000-01-01Z'::timestamptz) AS minute,count(*)::float8 AS requests ${scope.sql} GROUP BY 1)
    SELECT max(requests) FILTER(WHERE minute>=$2 AND minute+interval '60 seconds'<=$3) AS rpm,
      coalesce(sum(requests) FILTER(WHERE minute<$2 OR minute+interval '60 seconds'>$3),0)::float8 AS "incompleteMinuteRequests" FROM minutes`,
        ...scope.args,
      );
  const cache = warehouseFacts
    ? warehouseFacts.cache
    : await tx.query(
        `SELECT coalesce(lower(e.cache_status),'missing') AS status,count(*)::float8 AS requests ${scope.sql} GROUP BY 1 ORDER BY 1`,
        ...scope.args,
      );
  const fieldCoverage = warehouseFacts
    ? warehouseFacts.fieldCoverage
    : await tx.query(
        `WITH selected AS (${projection}) SELECT field,
    coalesce(edge_observation->'fields'->field->>'state','unknown') AS state,CASE WHEN field IN('OriginResponseDurationMs','edgeDurationMs') THEN NULL ELSE edge_observation->'fields'->field->'value' END AS value,count(*)::float8 AS requests
    FROM selected CROSS JOIN unnest(ARRAY['BotScore','BotScoreSrc','VerifiedBotCategory','EdgeResponseContentType','OriginResponseDurationMs','OriginResponseStatus','edgeDurationMs']) field
    GROUP BY 1,2,3 ORDER BY 1,2,3 LIMIT 100001`,
        ...scope.args,
      );
  const metric = (value: number | null, samples: number) =>
    evidenceValue(
      value,
      samples,
      totals.requests,
      !samples ? 'missing' : samples === totals.requests ? 'available' : 'partial',
      !samples ? 'no_valid_samples' : samples < 20 ? 'small_sample' : null,
    );
  return {
    meta: {
      ...evidenceMeta(p, input),
      quantiles: 'percentile_cont',
      minuteBasis: 'UTC_60_seconds',
      peakBasis: 'observed',
      latencyUnit: 'ms',
      byteUnits: 'separate',
    },
    fieldCoverage,
    ...(warehouseFacts
      ? {
          [warehouseEvidenceSections]: {
            reasons: warehouseFacts.cacheTable,
            fieldCoverage: warehouseFacts.fieldCoverageTable,
          },
        }
      : {}),
    rows: rows.map(row => ({
      ...row,
      bytes: evidenceValue(
        row.observedBytes,
        row.samples,
        row.requests,
        row.samples === row.requests ? 'available' : row.samples ? 'partial' : 'missing',
        row.samples < row.requests ? 'observed_subtotal' : null,
      ),
    })),
    totals: { ...totals, ...peak, peakMinuteAverageRps: peak.rpm === null ? null : peak.rpm / 60 },
    coverage: {
      edgeP50: metric(totals.edgeP50, totals.edgeSamples),
      edgeP95: metric(totals.edgeP95, totals.edgeSamples),
      originP50: metric(totals.originP50, totals.originSamples),
      originP95: metric(totals.originP95, totals.originSamples),
      cacheHitRatio: evidenceValue(
        totals.cacheSamples ? totals.hits / totals.cacheSamples : null,
        totals.cacheSamples,
        totals.requests,
        totals.cacheSamples ? 'available' : 'missing',
      ),
    },
    reasons: cache,
  };
}
