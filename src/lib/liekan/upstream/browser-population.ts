import type { AiTx } from './ai-db';
import type { BrowserPopulation } from '../contracts/browser-population';
import {
  identityUsable,
  totalIdentityFields,
  unavailableFields,
} from '../contracts/browser-population';
import { getQuerySnapshot } from './query-snapshot';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';
import { warehouseEnabled } from '../warehouse/runtime';

export const browserPopulationMetadataSql = `CASE WHEN EXISTS(SELECT 1 FROM website WHERE website_id=$1::uuid AND deleted_at IS NULL) THEN 'website'
        WHEN EXISTS(SELECT 1 FROM link WHERE link_id=$1::uuid AND deleted_at IS NULL) THEN 'link'
        WHEN EXISTS(SELECT 1 FROM pixel WHERE pixel_id=$1::uuid AND deleted_at IS NULL) THEN 'pixel' ELSE 'unknown' END AS "resourceKind",
(SELECT revision::text FROM liekan_collection_policy WHERE website_id=$1::uuid) AS "policyRevision",
      (SELECT active_generation::text FROM liekan_history_repair_run WHERE website_id=$1::uuid AND campaign_id='traffic-quality-repair-20261022-v1') AS "historyActiveGeneration",
      (SELECT active_revision::text FROM liekan_history_repair_run WHERE website_id=$1::uuid AND campaign_id='traffic-quality-repair-20261022-v1') AS "historyRevision",
      (SELECT epoch::text FROM liekan_log_state WHERE website_id=$1::uuid) AS epoch,
      (SELECT revision::text FROM liekan_traffic_governance WHERE website_id=$1::uuid) AS "governanceRevision",
      (SELECT max(received_cutoff) FROM liekan_traffic_exclusion WHERE website_id=$1::uuid AND state='active'
        AND epoch=COALESCE((SELECT epoch FROM liekan_log_state WHERE website_id=$1::uuid),1)) AS "governanceWatermark",
      (SELECT jsonb_build_object('computedAt',s.computed_at,'nextWindow',s.next_window,'errorCode',s.error_code)
        FROM liekan_browser_risk_state s WHERE s.website_id=$1::uuid
          AND s.epoch=COALESCE((SELECT epoch FROM liekan_log_state WHERE website_id=$1::uuid),1)) AS "governanceProcessing"`;

const versionLimit = 32;
type Executor = { $queryRawUnsafe: (sql: string, ...params: any[]) => any };
const reads = new WeakMap<object, Map<string, Promise<BrowserPopulation>>>();
const transactionExecutors = new WeakMap<AiTx, Executor>();

/** Reuses the caller's transaction and exact half-open event window. */
export function readTransactionBrowserPopulation(
  tx: AiTx,
  websiteId: string,
  range: { startAt: number; endAt: number; timezone: string },
) {
  let executor = transactionExecutors.get(tx);
  if (!executor) {
    executor = {
      $queryRawUnsafe: (sql, ...params) => (tx.queryPrepared || tx.query).call(tx, sql, ...params),
    };
    transactionExecutors.set(tx, executor);
  }
  return readBrowserPopulation(
    websiteId,
    new Date(range.startAt),
    new Date(range.endAt),
    range.timezone,
    executor,
    { halfOpen: true },
  );
}

export function populationFromRow(row: any, range: BrowserPopulation['range']): BrowserPopulation {
  const events = Number(row.eligibleEvents),
    reliable = Number(row.qualifiedEvents);
  const eligiblePV = Number(row.eligiblePV),
    qualifiedPV = Number(row.qualifiedPV);
  const sets = [row.identityVersions || [], row.ruleVersions || [], row.catalogVersions || []];
  return {
    populationVersion: TRAFFIC_POLICY_VERSION,
    ...(row.metricScope === 'qualified-browser' && row.resourceKind === 'website'
      ? { metricScope: 'qualified-browser' as const }
      : {}),
    resourceKind: row.resourceKind || 'unknown',
    capability: 'supported',
    scope: 'resource-window',
    policyRevision: row.policyRevision ?? '0',
    historyActiveGeneration: row.historyActiveGeneration ?? null,
    historyRevision: row.historyRevision ?? '0',
    epoch: row.epoch ?? '1',
    governanceRevision: row.governanceRevision ?? '0',
    governanceWatermark: row.governanceWatermark
      ? new Date(row.governanceWatermark).toISOString()
      : null,
    governanceProcessing: {
      state: row.governanceProcessing ? 'observed' : 'unknown',
      computedAt: row.governanceProcessing?.computedAt
        ? new Date(row.governanceProcessing.computedAt).toISOString()
        : null,
      nextWindow: row.governanceProcessing?.nextWindow
        ? new Date(row.governanceProcessing.nextWindow).toISOString()
        : null,
      errorCode: row.governanceProcessing?.errorCode ?? null,
    },
    identity: {
      status: !events
        ? 'empty'
        : events === reliable
          ? 'complete'
          : reliable
            ? 'partial'
            : 'unavailable',
      eligibleEvents: events,
      eligiblePV,
      qualifiedPV,
      qualifiedVisitors: Number(row.qualifiedVisitors),
      coverage: eligiblePV ? qualifiedPV / eligiblePV : null,
      versions: sets[0].slice(0, versionLimit),
    },
    ruleVersions: sets[1].slice(0, versionLimit),
    catalogVersions: sets[2].slice(0, versionLimit),
    versionSetsTruncated: sets.some(set => set.length > versionLimit),
    range,
  };
}
export function unsupportedPopulation(range: BrowserPopulation['range']): BrowserPopulation {
  return {
    populationVersion: TRAFFIC_POLICY_VERSION,
    resourceKind: 'unknown',
    capability: 'unsupported',
    scope: 'resource-window',
    policyRevision: null,
    historyActiveGeneration: null,
    historyRevision: null,
    epoch: null,
    governanceRevision: null,
    governanceWatermark: null,
    identity: {
      status: 'unsupported',
      eligibleEvents: null,
      eligiblePV: null,
      qualifiedPV: null,
      qualifiedVisitors: null,
      coverage: null,
      versions: [],
    },
    ruleVersions: [],
    catalogVersions: [],
    versionSetsTruncated: false,
    range,
  };
}

/** One deduplication over the entire resource window, shared by all reads in its reporting snapshot. */
export async function readBrowserPopulation(
  websiteId: string,
  startDate: Date,
  endDate: Date,
  timezone = 'UTC',
  executor?: Executor,
  options: { halfOpen?: boolean } = {},
): Promise<BrowserPopulation> {
  if(warehouseEnabled())return (await import('./warehouse-browser-population')).warehouseBrowserPopulation(websiteId,startDate,endDate,timezone,options.halfOpen);
  const range = {
    startAt: +startDate,
    endAt: +endDate,
    timezone,
    ...(options.halfOpen ? { endExclusive: true } : {}),
  };
  const tx = executor || getQuerySnapshot();
  if (!tx) {
    const { nativeSnapshot } = await import('./native-snapshot');
    return nativeSnapshot(() =>
      readBrowserPopulation(websiteId, startDate, endDate, timezone, undefined, options),
    );
  }
  let cache = reads.get(tx);
  if (!cache) reads.set(tx, (cache = new Map()));
  const key = JSON.stringify([websiteId, range]);
  if (!cache.has(key))
    cache.set(
      key,
      (async () => {
        if (process.env.CLICKHOUSE_URL) {
          const [resource] = await tx.$queryRawUnsafe(
            `SELECT CASE
        WHEN EXISTS(SELECT 1 FROM website WHERE website_id=$1::uuid AND deleted_at IS NULL) THEN 'website'
        WHEN EXISTS(SELECT 1 FROM link WHERE link_id=$1::uuid AND deleted_at IS NULL) THEN 'link'
        WHEN EXISTS(SELECT 1 FROM pixel WHERE pixel_id=$1::uuid AND deleted_at IS NULL) THEN 'pixel'
        ELSE 'unknown' END AS "resourceKind"`,
            websiteId,
          );
          return {
            ...unsupportedPopulation(range),
            resourceId: websiteId,
            resourceKind: resource.resourceKind,
          };
        }
        const { readAnalysisVisitPopulation } = await import('./analysis-rollups');
        const covered = await readAnalysisVisitPopulation(
          {
            websiteId,
            startDate,
            endDate,
            timezone,
            halfOpen: options.halfOpen,
          },
          tx,
        );
        if (covered) return covered;
        const [row] = await tx.$queryRawUnsafe(
          `WITH population AS MATERIALIZED (
      SELECT e.event_id,e.session_id,e.event_type,(qualified.event_id IS NOT NULL OR e.event_type IN(3,4)) AS liekan_identity_available,env.identity_version,q.rule_version,q.catalog_version
      FROM liekan_observed_website_event e
      LEFT JOIN liekan_event_environment env ON env.website_id=e.website_id AND env.event_id=e.event_id
      LEFT JOIN liekan_reporting_event_quality q ON q.website_id=e.website_id AND q.event_id=e.event_id
      LEFT JOIN liekan_browser_identity qualified ON qualified.website_id=e.website_id AND qualified.event_id=e.event_id
      WHERE e.website_id=$1::uuid AND ${options.halfOpen ? 'e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz' : 'e.created_at BETWEEN $2::timestamptz AND $3::timestamptz'}
    ) SELECT
      ${browserPopulationMetadataSql},'qualified-browser' AS "metricScope",
      COUNT(*)::float8 AS "eligibleEvents",COUNT(*) FILTER(WHERE liekan_identity_available)::float8 AS "qualifiedEvents",
      COUNT(*) FILTER(WHERE event_type IN(1,3,4))::float8 AS "eligiblePV",
      COUNT(*) FILTER(WHERE event_type IN(1,3,4) AND liekan_identity_available)::float8 AS "qualifiedPV",
      COUNT(DISTINCT session_id) FILTER(WHERE event_type IN(1,3,4) AND liekan_identity_available)::float8 AS "qualifiedVisitors",
      ARRAY(SELECT DISTINCT identity_version FROM population WHERE identity_version IS NOT NULL ORDER BY 1 LIMIT 33) AS "identityVersions",
      ARRAY(SELECT DISTINCT rule_version FROM population WHERE rule_version IS NOT NULL ORDER BY 1 LIMIT 33) AS "ruleVersions",
      ARRAY(SELECT DISTINCT catalog_version::text FROM population WHERE catalog_version IS NOT NULL ORDER BY 1 LIMIT 33) AS "catalogVersions"
      FROM population`,
          websiteId,
          startDate,
          endDate,
        );
        return { ...populationFromRow(row, range), resourceId: websiteId };
      })(),
    );
  return cache.get(key);
}

/** These aliases are defined by the named native query contracts; PV/revenue fields stay countable. */
const queryIdentityFields: Record<string, readonly string[]> = {
  getWebsiteStats: totalIdentityFields,
  getBreakdown: totalIdentityFields,
  getPageviewMetrics: ['y'],
  getRevenueStats: ['unique_count', 'total_sessions'],
  getHeatmap: ['sessions'],
  getSessionValues: ['count'],
  getSessionDataProperties: ['total'],
  getSessionDataValues: ['total'],
  getSessionDataActivityStats: ['sessions', 'visits'],
  getSessionDataArraySeries: ['y'],
  getSessionDataDateSeries: ['y'],
  getSessionDataPropertySeries: ['y'],
  getSessionDataNumericSeries: ['y'],
  getSessionDataNumericStats: ['total', 'average', 'median', 'min', 'max'],
  getPageviewExpandedMetrics: totalIdentityFields,
  getSessionExpandedMetrics: totalIdentityFields,
  getChannelExpandedMetrics: totalIdentityFields,
  getSessionStats: ['y'],
  getSessionMetrics: ['y'],
  getChannelMetrics: ['y'],
  getActiveVisitors: ['visitors'],
  getWebsiteSessionStats: ['visitors', 'visits', 'totaltime'],
  getAttribution: ['value'],
  getWeeklyTraffic: ['value'],
  getWebsiteListCharts: ['y'],
  getEventStats: ['visitors'],
  getWebsiteEventStats: ['visitors', 'visits'],
  getEventExpandedMetrics: totalIdentityFields,
  getGoal: ['num', 'total'],
  getRetention: ['visitors', 'returnVisitors', 'percentage'],
  getFunnel: ['count'],
  getJourney: ['count'],
};
export function applyNativePopulation(rows: any[], name: string, population: BrowserPopulation) {
  const fields = queryIdentityFields[name];
  return rows.map(row => ({
    ...(!identityUsable(population) && fields ? unavailableFields(row, fields) : row),
    ...([
      'getWebsiteStats',
      'getActiveVisitors',
      'getWebsiteSessionStats',
      'getWebsiteEventStats',
      'getGoal',
    ].includes(name)
      ? { population }
      : {}),
  }));
}
