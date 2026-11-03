import { createHash } from 'node:crypto';
import { identityComplete, unavailableFields } from '../contracts/browser-population';
import { CRAWLER_METRIC_VERSION, evidenceValue } from '../contracts/crawler-metrics';
import { EXPORT_MAX_BYTES, EXPORT_MAX_ROWS } from '../contracts/exports';
import {
  type EvidenceQuery,
  evidenceQuerySchema,
  type ReconciliationQuery,
  reconciliationQuerySchema,
} from '../contracts/traffic-evidence';
import { eventSamplingRateSql } from '../log-ingestion/measurement';
import { crawlerAiSql, unknownCrawlerSql } from '../rules/population';
import { type AiTx, aiExecutor } from '../upstream/ai-db';
import { AnalyticsUnavailable, analyticsGate } from '../upstream/analytics-budget';
import { readTransactionBrowserPopulation } from '../upstream/browser-population';
import { noteBrowserPopulation } from '../upstream/cache-context';
import { normalizeCollectionHostname } from '../upstream/collection-quality';
import {
  authorizeCrawler,
  type CrawlerActor,
  crawlerTransaction,
} from '../upstream/crawler-access';
import { withPublishedRegistry } from '../upstream/crawler-registry-context';
import { LiekanError } from '../upstream/errors';
import { evidenceCache } from '../upstream/evidence-cache';
import { humanPathFromEncoded } from '../upstream/paths';
import { analyticsCacheKey, websiteCacheTag } from '../upstream/query-cache';
import { cancellableEvidence } from '../upstream/query-cancellation';
import { getQuerySnapshot } from '../upstream/query-snapshot';
import { TRAFFIC_POLICY_VERSION } from '../upstream/traffic-query';
import { warehouseControlRead } from '../upstream/warehouse-control-read';
import { warehouseEvidenceCatalog } from '../upstream/warehouse-evidence-catalog';
import {
  warehouseCrawlerEvidence,
  warehouseEvidenceMeasurement,
  warehouseEvidenceRead,
  warehouseEvidenceSignal,
  warehouseReconciliationFacts,
} from '../upstream/warehouse-evidence-queries';
import {
  type WarehouseEvidenceRows,
  warehouseEvidenceRows,
  warehouseEvidenceSections,
  withWarehouseEvidenceResources,
} from '../upstream/warehouse-evidence-table';
import {
  warehouseControlFingerprint,
  warehouseReportMetadata,
  withinWarehouseReport,
} from '../upstream/warehouse-report-snapshot';
import { warehouseEnabled } from '../warehouse/authority-routing';
import { crawlerBase, crawlerWindowQuality } from './analysis';
import { crawlerOwnedBlock, crawlerOwnedMatch } from './execution';
import { crawlerIdentitySql } from './metric-scope';
import { getPublishedCatalog } from './published';

export function parseEvidenceQuery(input: unknown, reconciliation = false, now = Date.now()) {
  const parsed = (reconciliation ? reconciliationQuerySchema : evidenceQuerySchema).safeParse(
    input,
  );
  if (!parsed.success) throw new LiekanError('统计条件无效', 400);
  const p = parsed.data;
  if (
    'reportResource' in p &&
    p.reportResource &&
    (p.sourceId ||
      (p.reportResource !== 'ai/pages' && (p.botId || p.botName || p.botType)) ||
      p.path ||
      p.recognitionGroup ||
      p.responseGroup ||
      p.verificationGroup)
  )
    throw new LiekanError('统计条件无效', 400);
  if (
    (('botProductForm' in p && p.botProductForm) || ('botCategory' in p && p.botCategory)) &&
    (!('reportResource' in p) || !['ai/bots', 'ai/pages'].includes(p.reportResource))
  )
    throw new LiekanError('统计条件无效', 400);
  if ('botCategory' in p && p.botCategory && (p.botType || p.botProductForm))
    throw new LiekanError('统计条件无效', 400);
  if (p.startAt >= p.endAt || p.endAt > now || p.endAt - p.startAt > 90 * 86400000)
    throw new LiekanError('分析时间范围需要在过去 90 天内', 400);
  try {
    new Intl.DateTimeFormat('en', { timeZone: p.timezone });
  } catch {
    throw new LiekanError('时区无效', 400);
  }
  return p;
}
export const contentHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function enforceEvidenceBudget(value: unknown, count: number) {
  if (count > EXPORT_MAX_ROWS || Buffer.byteLength(JSON.stringify(value)) > EXPORT_MAX_BYTES)
    throw new LiekanError('统计结果超出上限，请缩小范围', 413);
}
export function evidenceScope(
  websiteId: string,
  p: EvidenceQuery,
  recognized = true,
  verification = true,
) {
  const args: unknown[] = [websiteId, new Date(p.startAt), new Date(p.endAt)];
  let sql = crawlerBase;
  if (p.population === 'ai_crawlers') sql += ` AND ${crawlerAiSql('l')}`;
  if (recognized && p.population !== 'all_logs') sql += ` AND NOT ${unknownCrawlerSql('l')}`;
  if (verification) sql += crawlerIdentitySql(p.crawlerIdentityScope, 'l');
  for (const [value, expression] of [
    [p.sourceId, 'l.source_id'],
    [p.botId, 'e.crawler_id'],
    [p.botName, 'l.bot'],
    [p.botType, 'l.bot_type'],
    [p.path, 'l.path'],
  ] as const) {
    if (!value) continue;
    if (expression === 'l.source_id' && value === 'manual') sql += ' AND l.source_id IS NULL';
    else {
      args.push(value);
      sql += ` AND ${expression}=$${args.length}${expression === 'l.source_id' ? '::uuid' : ''}`;
    }
  }
  if (p.recognitionGroup === 'ambiguous') sql += " AND l.recognition_state='ambiguous'";
  if (p.search) {
    args.push(p.search);
    sql += ` AND (position(lower($${args.length}) in lower(l.path))>0 OR position(lower($${args.length}) in lower(l.bot))>0)`;
  }
  if (p.logFilter === 'ai') sql += ` AND ${crawlerAiSql('l')}`;
  if (p.logFilter === 'abnormal') sql += ' AND l.status>=400';
  if (p.logFilter === 'other') sql += ` AND ${unknownCrawlerSql('l')}`;
  return { sql, args };
}
export async function evidenceInputs(
  tx: AiTx,
  actor: CrawlerActor,
  websiteId: string,
  p: Pick<EvidenceQuery, 'startAt' | 'endAt' | 'timezone'> & Partial<EvidenceQuery>,
  browserOnly = false,
) {
  const access = await authorizeCrawler(tx, actor, websiteId);
  const sources = browserOnly
    ? []
    : await tx.query(
        'SELECT id,kind,domain,state FROM liekan_log_source WHERE website_id=$1::uuid ORDER BY id',
        websiteId,
      );
  if (p.sourceId && p.sourceId !== 'manual' && !sources.some(source => source.id === p.sourceId))
    throw new LiekanError('日志来源不存在', 404);
  const catalog =
    browserOnly || warehouseEnabled()
      ? []
      : await tx.query<{ path: string; updatedAt: Date }>(
          'SELECT path,updated_at AS "updatedAt" FROM liekan_catalog WHERE website_id=$1::uuid ORDER BY path',
          websiteId,
        );
  const catalogSummary =
    warehouseEnabled() && !browserOnly
      ? await warehouseEvidenceCatalog(websiteId, warehouseEvidenceSignal())
      : { hash: contentHash(catalog), count: catalog.length };
  const [policy] = await tx.query(
    'SELECT mode,revision::text,allowed_hostnames FROM liekan_collection_policy WHERE website_id=$1::uuid',
    websiteId,
  );
  const [state] = await tx.query(
    'SELECT epoch,data_revision::text FROM liekan_log_state WHERE website_id=$1::uuid',
    websiteId,
  );
  const quality = browserOnly
    ? {
        state: 'unknown' as const,
        basis: 'unknown' as const,
        classificationVersion: '',
        sourceVersion: '',
        timezone: p.timezone,
      }
    : await crawlerWindowQuality(
        tx,
        websiteId,
        p.startAt,
        p.endAt,
        p.timezone,
        p.sourceId === 'manual' ? undefined : p.sourceId,
      );
  // Manual history has no automatic-source continuity proof.
  if (p.sourceId === 'manual') quality.state = 'unknown';
  const sourceArgs: unknown[] = [websiteId, new Date(p.startAt), new Date(p.endAt)];
  const sourceCondition =
    p.sourceId === 'manual'
      ? ' AND l.source_id IS NULL'
      : p.sourceId
        ? ' AND l.source_id=$4::uuid'
        : '';
  if (p.sourceId && p.sourceId !== 'manual') sourceArgs.push(p.sourceId);
  const [measurement] = browserOnly
    ? [{ requests: 0, versions: 0, samples: 0, intervals: 0, interval: null, intervalSamples: 0 }]
    : warehouseEnabled()
      ? [await warehouseEvidenceMeasurement(websiteId, p)]
      : await tx.query(
          `SELECT count(*)::float8 AS requests,count(distinct e.measurement->>'sourceConfigVersion')::int AS versions,
    count(*) FILTER(WHERE e.measurement->>'sourceConfigVersion' IS NOT NULL)::float8 AS samples,
    count(distinct e.measurement->>'sourceIntervalVersion')::int AS intervals,min(e.measurement->>'sourceIntervalVersion') AS interval,
    count(*) FILTER(WHERE e.measurement->>'sourceIntervalVersion' IS NOT NULL)::float8 AS "intervalSamples" ${crawlerBase}${sourceCondition}`,
          ...sourceArgs,
        );
  const [repair] =
    'reportResource' in p && p.reportResource
      ? await tx.query(
          'SELECT active_generation::text AS generation,active_revision::text AS revision FROM liekan_history_repair_run WHERE website_id=$1::uuid',
          websiteId,
        )
      : [];
  const baseline = {
    catalog: catalogSummary.hash,
    registryVersion: getPublishedCatalog()?.version ?? null,
    populationVersion: TRAFFIC_POLICY_VERSION,
    policy: policy || { mode: 'standard', revision: '0' },
    epoch: state?.epoch ?? 1,
    metricVersion: CRAWLER_METRIC_VERSION,
    ...(warehouseEnabled()
      ? { warehouse: warehouseControlFingerprint(await warehouseReportMetadata(websiteId)) }
      : {}),
    ...('reportResource' in p && p.reportResource
      ? { historyRepair: repair || { generation: null, revision: '0' } }
      : {}),
  };
  return {
    access,
    sources,
    catalog,
    catalogCount: catalogSummary.count,
    measurement,
    policy: baseline.policy,
    quality,
    baseline,
    policySnapshot: contentHash(baseline),
    dataRevision: state?.data_revision ?? '0',
  };
}
export type EvidenceInputs = Awaited<ReturnType<typeof evidenceInputs>>;
export function evidenceMeta(
  p: Pick<EvidenceQuery, 'startAt' | 'endAt' | 'timezone'> & Partial<EvidenceQuery>,
  input: EvidenceInputs,
) {
  return {
    metricVersion: CRAWLER_METRIC_VERSION,
    conditions: p,
    population: p.population ?? 'recognized_crawlers',
    timeBasis: 'event_time',
    timeBoundary: 'half_open',
    readAt: new Date().toISOString(),
    catalogBaseline: input.baseline.catalog,
    registryVersion: input.baseline.registryVersion,
    populationVersion: input.baseline.populationVersion,
    policySnapshot: input.policySnapshot,
    policy: input.policy,
    dataRevision: input.dataRevision,
    epoch: input.baseline.epoch,
    quality: input.quality,
    sourceMeasurement: input.measurement,
    sources: input.sources,
  };
}
export function pathMappings(paths: string[]) {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const human = humanPathFromEncoded(path);
    groups.set(human, [...new Set([...(groups.get(human) || []), path])]);
  }
  return [...groups].map(([humanPath, encodedPaths]) => ({
    humanPath,
    encodedPaths,
    ambiguous: encodedPaths.length > 1,
  }));
}
export async function readCrawlerEvidence(
  tx: AiTx,
  websiteId: string,
  p: EvidenceQuery,
  input: EvidenceInputs,
) {
  if (warehouseEnabled()) return warehouseCrawlerEvidence(tx, websiteId, p, input);
  if (p.view === 'summary') {
    const scope = evidenceScope(websiteId, p);
    const group =
      p.dimension === 'path'
        ? 'l.path'
        : p.dimension === 'day'
          ? `to_char(l.created_at AT TIME ZONE $${scope.args.length + 1},'YYYY-MM-DD')`
          : 'l.bot';
    if (p.dimension === 'day') scope.args.push(p.timezone);
    const rows = await tx.query(
      `SELECT ${group} AS name,count(*)::float8 AS requests,count(distinct l.path)::float8 AS pages,
      count(*) FILTER(WHERE method='GET' AND status BETWEEN 200 AND 299)::float8 AS "get2xx",
      count(*) FILTER(WHERE status>=400)::float8 AS abnormal,max(l.created_at) AS "lastVisit" ${scope.sql} GROUP BY 1 ORDER BY 1 LIMIT 100001`,
      ...scope.args,
    );
    return { meta: evidenceMeta(p, input), rows };
  }
  if (p.view === 'requests') {
    const scope = evidenceScope(websiteId, p);
    const responses: Record<string, string> = {
      '1xx': 'status BETWEEN 100 AND 199',
      '2xx': 'status BETWEEN 200 AND 299',
      '3xx': 'status BETWEEN 300 AND 399 AND status<>304',
      '304': 'status=304',
      denied: 'status IN(401,403,429,451)',
      other4xx: 'status BETWEEN 400 AND 499 AND status NOT IN(401,403,429,451)',
      '5xx': 'status BETWEEN 500 AND 599',
    };
    if (p.responseGroup) scope.sql += ` AND (${responses[p.responseGroup]})`;
    if (p.verificationGroup) {
      scope.args.push(p.verificationGroup);
      scope.sql += ` AND CASE WHEN verification IN('verified_range','verified_dns','verified_edge','range_mismatch') THEN verification ELSE 'unverified' END=$${scope.args.length}`;
    }
    const rows = await tx.query(
      `SELECT l.id,l.created_at AS time,l.path,l.method,l.status,l.bot,l.verification ${scope.sql} ORDER BY l.created_at DESC,l.id DESC LIMIT 100001`,
      ...scope.args,
    );
    enforceEvidenceBudget(rows, rows.length);
    return { meta: evidenceMeta(p, input), rows, outsideScope: [] };
  }
  const all = evidenceScope(websiteId, p, true, false);
  const rows = await tx.query<{ identity: string; response: string; requests: number }>(
    `SELECT CASE WHEN verification IN('verified_range','verified_dns','verified_edge','range_mismatch') THEN verification ELSE 'unverified' END AS identity,
    CASE WHEN status<200 THEN '1xx' WHEN status<300 THEN '2xx' WHEN status=304 THEN '304' WHEN status<400 THEN '3xx' WHEN status IN(401,403,429,451) THEN 'denied' WHEN status<500 THEN 'other4xx' ELSE '5xx' END AS response,count(*)::float8 AS requests
    ${all.sql} GROUP BY 1,2 ORDER BY 1,2`,
    ...all.args,
  );
  const scope = evidenceScope(websiteId, p);
  const [totals] = await tx.query(
    `SELECT count(*)::float8 AS requests,count(*) FILTER(WHERE method='GET' AND status BETWEEN 200 AND 299)::float8 AS "get2xx",
    count(*) FILTER(WHERE method='GET' AND status IN(204,205))::float8 AS "getNoBody",count(*) FILTER(WHERE method='GET' AND status=206)::float8 AS "getPartial",count(*) FILTER(WHERE method='HEAD')::float8 AS head,
    count(*) FILTER(WHERE status=401)::float8 AS "status401",count(*) FILTER(WHERE status=403)::float8 AS "status403",count(*) FILTER(WHERE status=429)::float8 AS "status429",count(*) FILTER(WHERE status=451)::float8 AS "status451",
    count(*) FILTER(WHERE ${crawlerOwnedBlock})::float8 AS "ownedTerminatingBlocks",count(*) FILTER(WHERE ${crawlerOwnedMatch})::float8 AS "ownedMatches",
    count(distinct l.path) FILTER(WHERE EXISTS(SELECT 1 FROM liekan_catalog c WHERE c.website_id=l.website_id AND c.path=l.path))::float8 AS "requestedCatalogPaths",
    count(distinct l.path) FILTER(WHERE method='GET' AND status BETWEEN 200 AND 299 AND EXISTS(SELECT 1 FROM liekan_catalog c WHERE c.website_id=l.website_id AND c.path=l.path))::float8 AS "respondedCatalogPaths"
    ${scope.sql}`,
    ...scope.args,
  );
  const reasons = await tx.query(
    `SELECT coalesce(verification_reason,'legacy_unknown') AS reason,count(*)::float8 AS requests ${scope.sql} GROUP BY 1 ORDER BY 1`,
    ...scope.args,
  );
  const ambiguousScope = evidenceScope(
    websiteId,
    {
      ...p,
      population: 'all_logs',
      botId: undefined,
      botName: undefined,
      botType: undefined,
      search: undefined,
      logFilter: undefined,
    },
    false,
    false,
  );
  const [ambiguous] = await tx.query(
    `SELECT count(*)::float8 AS requests ${ambiguousScope.sql} AND l.recognition_state='ambiguous'`,
    ...ambiguousScope.args,
  );
  const selected = rows.filter(
    row => p.crawlerIdentityScope === 'all' || row.identity === p.crawlerIdentityScope,
  );
  const denominator = input.catalog.filter(row => !p.path || row.path === p.path).length;
  return {
    meta: evidenceMeta(p, input),
    rows: selected,
    outsideScope: rows.filter(row => !selected.includes(row)),
    ambiguousRequests: ambiguous.requests,
    totals,
    reasons,
    coverage: evidenceValue(
      denominator ? totals.respondedCatalogPaths / denominator : null,
      totals.respondedCatalogPaths,
      denominator,
      denominator ? (input.quality.state === 'complete' ? 'available' : 'partial') : 'missing',
      denominator ? null : 'catalog_missing',
    ),
  };
}
export async function readReconciliation(
  tx: AiTx,
  websiteId: string,
  p: ReconciliationQuery,
  input: EvidenceInputs,
) {
  const browserPopulation = await readTransactionBrowserPopulation(tx, websiteId, p);
  const identityReady = identityComplete(browserPopulation);
  const hostname = normalizeCollectionHostname(p.hostname);
  const sourceHost =
    p.sourceId === 'manual'
      ? input.access.domain
      : input.sources.find(source => source.id === p.sourceId)?.domain;
  if (!hostname || hostname !== normalizeCollectionHostname(sourceHost))
    throw new LiekanError('对账主机不属于所选来源', 400);
  const paths = input.catalog.filter(row => !p.path || row.path === p.path).map(row => row.path);
  const mappings = pathMappings(input.catalog.map(row => row.path))
    .filter(row => !p.path || row.encodedPaths.includes(p.path))
    .map(row => ({
      ...row,
      collisionPaths: row.encodedPaths,
      encodedPaths: row.encodedPaths.filter(path => !p.path || path === p.path),
    }));
  const query = {
    ...p,
    view: 'matrix' as const,
    population: 'all_logs' as const,
    dimension: 'path' as const,
    crawlerIdentityScope: 'all' as const,
  };
  if (warehouseEnabled()) {
    const data = await warehouseReconciliationFacts(websiteId, p, hostname, input, identityReady);
    return {
      meta: {
        ...evidenceMeta(query, input),
        population: 'catalog_page_requests',
        hostname,
        browserPopulation,
      },
      rows: [],
      [warehouseEvidenceRows]: data.table,
      browserTotals:
        data.presence.connected && !data.unknownHosts
          ? identityReady
            ? data.browserTotals
            : unavailableFields(data.browserTotals, ['uv', 'visits'])
          : null,
      state: data.catalogRows ? 'available' : 'missing',
      reasonCode: data.catalogRows ? null : 'catalog_missing',
      rawRequests: data.rawRequests,
    };
  }
  const scope = evidenceScope(websiteId, query, false);
  const logs = await tx.query(
    `SELECT l.path,count(*)::float8 AS requests,
    count(*) FILTER(WHERE method='GET' AND status BETWEEN 200 AND 299)::float8 AS "get2xx",
    count(*) FILTER(WHERE method='GET' AND status BETWEEN 200 AND 299 AND NOT ${unknownCrawlerSql('l')})::float8 AS crawler,
    count(*) FILTER(WHERE method='GET' AND status BETWEEN 200 AND 299 AND ${unknownCrawlerSql('l')})::float8 AS candidate,
    count(*) FILTER(WHERE recognition_state='ambiguous')::float8 AS ambiguous,
    count(*) FILTER(WHERE e.edge_observation->'fields'->'EdgeResponseContentType'->>'state'='present')::float8 AS "contentTypeSamples",
    count(*) FILTER(WHERE method='GET' AND status BETWEEN 200 AND 299 AND e.edge_observation->'fields'->'EdgeResponseContentType'->>'value' IN('text/html','application/xhtml+xml'))::float8 AS "confirmedHtml",
    count(*) FILTER(WHERE e.measurement->>'hostBasis'='request_host' AND regexp_replace(lower(rtrim(e.measurement->>'host','.')),'^www[.]','')=$${scope.args.length + 1})::float8 AS "hostSamples",
    count(distinct e.measurement->>'sourceConfigVersion')::int AS "configVersions",
    count(*) FILTER(WHERE e.measurement->>'sourceConfigVersion' IS NOT NULL)::float8 AS "configSamples",
    count(*) FILTER(WHERE (${eventSamplingRateSql})=1)::float8 AS "unsampledRequests"
    ${scope.sql} GROUP BY l.path ORDER BY l.path LIMIT 100001`,
    ...scope.args,
    hostname,
  );
  enforceEvidenceBudget(logs, logs.length);
  const human = await tx.query(
    `SELECT e.url_path AS path,count(*)::float8 AS pv,count(distinct e.session_id)::float8 AS uv,count(distinct (e.visit_id,e.session_id))::float8 AS visits
    FROM website_event e JOIN liekan_event_quality q ON q.event_id=e.event_id AND q.website_id=e.website_id
    WHERE e.website_id=$1::uuid AND e.created_at>=$2 AND e.created_at<$3 AND e.event_type=1 AND q.hostname=$4 AND e.url_path=ANY($5::text[]) GROUP BY 1 ORDER BY 1`,
    websiteId,
    new Date(p.startAt),
    new Date(p.endAt),
    hostname,
    mappings.map(row => row.humanPath),
  );
  const unknownHosts = await tx.query(
    `SELECT e.url_path AS path,count(*)::float8 AS requests FROM website_event e LEFT JOIN liekan_event_quality q ON q.event_id=e.event_id AND q.website_id=e.website_id WHERE e.website_id=$1::uuid AND e.created_at>=$2 AND e.created_at<$3 AND e.event_type=1 AND q.hostname IS NULL AND e.url_path=ANY($4::text[]) GROUP BY 1`,
    websiteId,
    new Date(p.startAt),
    new Date(p.endAt),
    mappings.map(row => row.humanPath),
  );
  const unknownByPath = new Map(unknownHosts.map(row => [row.path, row.requests]));
  const [presence] = await tx.query(
    'SELECT EXISTS(SELECT 1 FROM liekan_raw_website_event WHERE website_id=$1::uuid LIMIT 1) AS connected',
    websiteId,
  );
  const logByPath = new Map(logs.map(row => [row.path, row]));
  const humanByPath = new Map(human.map(row => [row.path, row]));
  const rows = mappings.map(mapping => {
    const log = mapping.encodedPaths.map(path => logByPath.get(path)).filter(Boolean);
    const total = (key: string) => log.reduce((sum, row) => sum + Number(row[key]), 0);
    const browser = humanByPath.get(mapping.humanPath);
    const requests = total('requests');
    const reason = mapping.ambiguous
      ? 'ambiguous_path'
      : !requests
        ? 'measurement_missing'
        : !presence.connected
          ? 'browser_missing'
          : unknownByPath.has(mapping.humanPath)
            ? 'browser_host_unknown'
            : input.measurement.intervals !== 1 ||
                input.measurement.interval !== input.quality.sourceVersion ||
                input.measurement.intervalSamples !== input.measurement.requests ||
                input.measurement.versions !== 1 ||
                input.measurement.samples !== input.measurement.requests ||
                total('configSamples') !== requests ||
                log.some(row => row.configVersions !== 1)
              ? 'source_config_unknown'
              : input.quality.state !== 'complete'
                ? 'source_coverage'
                : total('hostSamples') !== requests
                  ? 'host_evidence'
                  : total('unsampledRequests') !== requests
                    ? 'sampling_unknown'
                    : null;
    return {
      ...mapping,
      requests,
      get2xx: total('get2xx'),
      crawler: total('crawler'),
      candidate: total('candidate'),
      ambiguous: mapping.ambiguous,
      ambiguousRequests: total('ambiguous'),
      confirmedHtml: total('confirmedHtml'),
      contentType: evidenceValue(
        requests ? total('contentTypeSamples') / requests : null,
        total('contentTypeSamples'),
        requests,
        total('contentTypeSamples') === requests && requests > 0
          ? 'available'
          : total('contentTypeSamples')
            ? 'partial'
            : 'missing',
      ),
      observedPv: presence.connected ? (browser?.pv ?? 0) : null,
      unknownHostPv: unknownByPath.get(mapping.humanPath) ?? 0,
      pv: presence.connected && !unknownByPath.has(mapping.humanPath) ? (browser?.pv ?? 0) : null,
      uv:
        identityReady && presence.connected && !unknownByPath.has(mapping.humanPath)
          ? (browser?.uv ?? 0)
          : null,
      visits:
        identityReady && presence.connected && !unknownByPath.has(mapping.humanPath)
          ? (browser?.visits ?? 0)
          : null,
      difference: evidenceValue(
        reason ? null : total('candidate') - (browser?.pv ?? 0),
        total('hostSamples'),
        requests,
        reason ? 'not_comparable' : 'available',
        reason,
      ),
    };
  });
  const [browserTotals] = await tx.query(
    `SELECT count(*)::float8 AS pv,count(distinct e.session_id)::float8 AS uv,count(distinct(e.visit_id,e.session_id))::float8 AS visits FROM website_event e JOIN liekan_event_quality q ON q.event_id=e.event_id AND q.website_id=e.website_id WHERE e.website_id=$1::uuid AND e.created_at>=$2 AND e.created_at<$3 AND e.event_type=1 AND q.hostname=$4 AND e.url_path=ANY($5::text[])`,
    websiteId,
    new Date(p.startAt),
    new Date(p.endAt),
    hostname,
    mappings.map(row => row.humanPath),
  );
  return {
    meta: {
      ...evidenceMeta(query, input),
      population: 'catalog_page_requests',
      hostname,
      browserPopulation,
    },
    rows,
    browserTotals:
      presence.connected && !unknownHosts.length
        ? identityReady
          ? browserTotals
          : unavailableFields(browserTotals, ['uv', 'visits'])
        : null,
    state: paths.length ? 'available' : 'missing',
    reasonCode: paths.length ? null : 'catalog_missing',
    rawRequests: logs.reduce((n, row) => n + row.requests, 0),
  };
}
export type EvidenceReader = (
  tx: AiTx,
  websiteId: string,
  p: any,
  input: EvidenceInputs,
) => Promise<any>;
async function queryEvidenceSnapshot<
  P extends {
    startAt: number;
    endAt: number;
    timezone: string;
    page: number;
    snapshot?: string;
    sort: 'requests' | 'visits' | 'path';
    direction: 'asc' | 'desc';
  },
>(
  actor: CrawlerActor,
  websiteId: string,
  p: P,
  kind: string,
  reader: EvidenceReader,
  fresh = false,
  signal?: AbortSignal,
) {
  try {
    const conditions = {
      ...p,
      page: 1,
      snapshot: undefined,
      reasonsPage: undefined,
      fieldCoveragePage: undefined,
    };
    const revisions = await crawlerTransaction(async tx => {
      await authorizeCrawler(tx, actor, websiteId);
      const [log] = await tx.query(
        'SELECT epoch,data_revision::text FROM liekan_log_state WHERE website_id=$1::uuid',
        websiteId,
      );
      const [browser] = await tx.query(
        "SELECT revision::text FROM liekan_analytics_revision WHERE resource_type='website' AND resource_id=$1::uuid",
        websiteId,
      );
      const [policy] = await tx.query(
        'SELECT mode,revision FROM liekan_collection_policy WHERE website_id=$1::uuid',
        websiteId,
      );
      const [catalog] = await tx.query(
        'SELECT max(updated_at)::text AS updated,count(*)::int AS count FROM liekan_catalog WHERE website_id=$1::uuid',
        websiteId,
      );
      const [observation] = await tx.query(
        'SELECT epoch,first_received_at::text,last_received_at::text,pruned_before::text FROM liekan_observation_state WHERE website_id=$1::uuid',
        websiteId,
      );
      return {
        log,
        browser,
        policy,
        catalog,
        observation,
        ...(warehouseEnabled() ? { warehouse: await warehouseReportMetadata(websiteId) } : {}),
      };
    });
    const calculate = async (raw: AiTx, computeSignal?: AbortSignal) =>
      (warehouseEnabled()
        ? (_tx: AiTx, signal: AbortSignal | undefined, work: () => Promise<any>) =>
            warehouseEvidenceRead(work, signal)
        : cancellableEvidence)(raw, computeSignal, async () => {
        const deadline = Date.now() + 59000;
        const checkCancellation = () => {
          if (computeSignal?.aborted) throw new LiekanError('统计读取已取消', 499);
        };
        const tx: AiTx = warehouseEnabled()
          ? raw
          : {
              queryPrepared: async (sql, ...args) => {
                checkCancellation();
                const left = deadline - Date.now();
                if (left <= 0) throw new AnalyticsUnavailable();
                await raw.execute(
                  `SET LOCAL statement_timeout TO '${Math.max(1, Math.floor(left))}ms'`,
                );
                if (!raw.queryPrepared) throw new Error('Prepared query executor unavailable');
                return raw.queryPrepared(sql, ...args);
              },
              execute: async (sql, ...args) => {
                checkCancellation();
                return raw.execute(sql, ...args);
              },
              query: async (sql, ...args) => {
                checkCancellation();
                const left = deadline - Date.now();
                if (left <= 0) throw new AnalyticsUnavailable();
                await raw.execute(
                  `SET LOCAL statement_timeout TO '${Math.max(1, Math.floor(left))}ms'`,
                );
                return raw.query(sql, ...args);
              },
            };
        const input = await evidenceInputs(
          tx,
          actor,
          websiteId,
          conditions,
          kind === 'observations',
        );
        const result = await reader(tx, websiteId, conditions, input);
        const table = result[warehouseEvidenceRows] as WarehouseEvidenceRows | undefined;
        if (table) result.meta.total = await table.count(computeSignal);
        const sections = result[warehouseEvidenceSections] as
          | Record<string, WarehouseEvidenceRows>
          | undefined;
        if (sections) {
          result.meta.sectionTotals = {};
          for (const [name, section] of Object.entries(sections))
            result.meta.sectionTotals[name] = await section.count(computeSignal);
        }
        if (
          !table &&
          result.rows &&
          kind !== 'report-evidence' &&
          !(kind.endsWith('evidence') && (!('view' in p) || p.view === 'matrix'))
        ) {
          const direction = p.direction === 'asc' ? 1 : -1;
          result.rows.sort((a: any, b: any) => {
            const key = p.sort;
            const first =
              key === 'path'
                ? String(a.humanPath ?? a.path ?? '').localeCompare(
                    String(b.humanPath ?? b.path ?? ''),
                    'en',
                  )
                : Number(a[key] ?? 0) - Number(b[key] ?? 0);
            return (
              first * direction ||
              String(a.platformId ?? '').localeCompare(String(b.platformId ?? ''), 'en') ||
              String(a.humanPath ?? a.path ?? a.id ?? '').localeCompare(
                String(b.humanPath ?? b.path ?? b.id ?? ''),
                'en',
              )
            );
          });
        }
        if (!table && !sections)
          enforceEvidenceBudget(
            result,
            Math.max(result.rows?.length ?? 0, result.fieldCoverage?.length ?? 0),
          );
        const stableMeta = Object.fromEntries(
          [
            'metricVersion',
            'conditions',
            'population',
            'timeBasis',
            'timeBoundary',
            'catalogBaseline',
            'policySnapshot',
            'policy',
            'epoch',
            'hostname',
            'mappingVersion',
            'goalsConfigured',
            'browserPopulation',
            'observationIdentity',
          ]
            .filter(key => result.meta[key] !== undefined)
            .map(key => [key, result.meta[key]]),
        );
        const sectionHashes: Record<string, string> = {};
        if (sections)
          for (const [name, section] of Object.entries(sections))
            sectionHashes[name] = await section.fingerprint(computeSignal);
        const snapshot = warehouseEnabled()
          ? contentHash({
              version: 'warehouse-evidence-v3',
              kind,
              conditions,
              result: { ...result, meta: stableMeta },
              rows: table ? await table.fingerprint(computeSignal) : null,
              sections: sectionHashes,
              control: warehouseControlFingerprint(await warehouseReportMetadata(websiteId)),
            })
          : contentHash({ ...result, meta: stableMeta });
        return { ...result, meta: { ...result.meta, snapshot } };
      });
    const compute = (computeSignal?: AbortSignal) => {
      if (warehouseEnabled())
        return warehouseControlRead(tx => calculate(tx, computeSignal), { signal: computeSignal });
      const snapshot = getQuerySnapshot();
      return snapshot
        ? calculate(aiExecutor(snapshot), computeSignal)
        : analyticsGate.run(() =>
            crawlerTransaction(tx => calculate(tx, computeSignal), {
              timeout: 59000,
              transactionTimeout: 60000,
              repeatableRead: true,
            }),
          );
    };
    const result = await (async () => {
      try {
        return fresh || warehouseEnabled()
          ? await compute(signal)
          : await evidenceCache.read(
              analyticsCacheKey(`traffic-evidence-identity-v1-${kind}`, {
                websiteId,
                conditions,
                revisions,
                populationVersion: TRAFFIC_POLICY_VERSION,
              }),
              [websiteCacheTag(websiteId)],
              compute,
              signal,
            );
      } catch (error) {
        if (
          (error as any)?.code === 'P2028' ||
          /statement timeout/.test(String((error as any)?.message))
        )
          throw new AnalyticsUnavailable('统计查询超时，请缩小时间范围后重试');
        throw error;
      }
    })();
    if (signal?.aborted) throw new LiekanError('统计读取已取消', 499);
    await crawlerTransaction(async tx => {
      await authorizeCrawler(tx, actor, websiteId);
      const [state] = await tx.query(
        'SELECT epoch FROM liekan_log_state WHERE website_id=$1::uuid',
        websiteId,
      );
      const [policy] = await tx.query(
        'SELECT mode,revision::text,allowed_hostnames FROM liekan_collection_policy WHERE website_id=$1::uuid',
        websiteId,
      );
      const catalog =
        kind === 'observations' || warehouseEnabled()
          ? []
          : await tx.query(
              'SELECT path,updated_at AS "updatedAt" FROM liekan_catalog WHERE website_id=$1::uuid ORDER BY path',
              websiteId,
            );
      const [repair] =
        'reportResource' in conditions && conditions.reportResource
          ? await tx.query(
              'SELECT active_generation::text AS generation,active_revision::text AS revision FROM liekan_history_repair_run WHERE website_id=$1::uuid',
              websiteId,
            )
          : [];
      const baseline = {
        catalog: warehouseEnabled() ? result.meta.catalogBaseline : contentHash(catalog),
        registryVersion: getPublishedCatalog()?.version ?? null,
        populationVersion: TRAFFIC_POLICY_VERSION,
        policy: policy || { mode: 'standard', revision: '0' },
        epoch: state?.epoch ?? 1,
        metricVersion: CRAWLER_METRIC_VERSION,
        ...(warehouseEnabled()
          ? { warehouse: warehouseControlFingerprint(await warehouseReportMetadata(websiteId)) }
          : {}),
        ...('reportResource' in conditions && conditions.reportResource
          ? { historyRepair: repair || { generation: null, revision: '0' } }
          : {}),
      };
      if (contentHash(baseline) !== result.meta.policySnapshot)
        throw new LiekanError('统计基准已变化，请重新读取', 409);
    });
    if (result.meta.browserPopulation)
      noteBrowserPopulation(websiteId, result.meta.browserPopulation);
    const reset = !!p.snapshot && p.snapshot !== result.meta.snapshot;
    const page = reset ? 1 : p.page;
    const table = result[warehouseEvidenceRows] as WarehouseEvidenceRows | undefined;
    const sections = result[warehouseEvidenceSections] as
      | Record<string, WarehouseEvidenceRows>
      | undefined;
    const sectionPages: Record<string, any[]> = {};
    const sectionMetadata: Record<string, { page: number; total: number; pageSize: 20 }> = {};
    if (sections)
      for (const [name, section] of Object.entries(sections)) {
        const sectionPage = reset
          ? 1
          : name === 'reasons'
            ? ((p as { reasonsPage?: number }).reasonsPage ?? 1)
            : name === 'fieldCoverage'
              ? ((p as { fieldCoveragePage?: number }).fieldCoveragePage ?? 1)
              : page;
        const total = result.meta.sectionTotals[name];
        sectionPages[name] =
          (sectionPage - 1) * 20 >= total
            ? []
            : await section.page((sectionPage - 1) * 20, 20, signal);
        sectionMetadata[name] = { page: sectionPage, total, pageSize: 20 };
      }
    const pageRows = table
      ? (page - 1) * 20 >= result.meta.total
        ? []
        : await table.page((page - 1) * 20, 20, signal)
      : undefined;
    if (table || sections) await crawlerTransaction(tx => authorizeCrawler(tx, actor, websiteId));
    return {
      ...result,
      ...sectionPages,
      rows: table
        ? pageRows
        : fresh || (kind.endsWith('evidence') && (!('view' in p) || p.view === 'matrix'))
          ? result.rows
          : result.rows.slice((page - 1) * 20, page * 20),
      meta: {
        ...result.meta,
        page,
        pageSize: 20,
        total: table ? result.meta.total : result.rows.length,
        reset,
        ...(sections ? { sectionPages: sectionMetadata } : {}),
      },
    };
  } catch (error) {
    if (
      (error as any)?.code === 'P2028' ||
      /statement timeout/.test(String((error as any)?.message))
    )
      throw new AnalyticsUnavailable('统计查询超时，请缩小时间范围后重试');
    throw error;
  }
}

export const queryEvidence: typeof queryEvidenceSnapshot = (...args) => {
  return withPublishedRegistry(() =>
    warehouseEnabled()
      ? withWarehouseEvidenceResources(() =>
          withinWarehouseReport(() => queryEvidenceSnapshot(...args)),
        )
      : queryEvidenceSnapshot(...args),
  );
};
