import { AsyncLocalStorage } from 'node:async_hooks';
import { evidenceValue } from '../contracts/crawler-metrics';
import type { EvidenceQuery, ReconciliationQuery } from '../contracts/traffic-evidence';
import type { EvidenceInputs } from '../crawlers/evidence-read';
import { evidenceMeta } from '../crawlers/evidence-read';
import { crawlerIdentitySql } from '../crawlers/metric-scope';
import { crawlerAiSql, unknownCrawlerSql } from '../rules/population';
import { BROWSER_RISK_VERSION } from '../traffic-quality/behavior';
import { warehouseTime } from '../warehouse/fact-input';
import { factRelation } from '../warehouse/read';
import {
  effectiveLogRelation,
  repairedQualityRelation,
  websiteEventRelation,
} from '../warehouse/reporting-relations';
import { riskRelation } from '../warehouse/risk-proof';
import type { AiTx } from './ai-db';
import { OBSERVATION_VERSION } from './collection-observation';
import { warehouseCatalogPaths, warehouseCatalogProjection } from './warehouse-catalog';
import {
  warehouseCatalogHumanPaths,
  warehouseCatalogHumanRelation,
} from './warehouse-catalog-human-paths';
import { warehouseEvidenceRows, warehouseEvidenceTable } from './warehouse-evidence-table';
import { warehouseBrowserConnected } from './warehouse-presence';
import { warehouseReportQuery, warehouseReportStream } from './warehouse-report-snapshot';

const context = new AsyncLocalStorage<{ signal?: AbortSignal }>();
const numericFields = new Set(
  `requests versions samples intervals intervalSamples pages get2xx abnormal getNoBody getPartial head
 status401 status403 status429 status451 ownedTerminatingBlocks ownedMatches requestedCatalogPaths respondedCatalogPaths
 hosts configs crawler candidate ambiguous contentTypeSamples confirmedHtml hostSamples configVersions configSamples unsampledRequests
 pv uv visits observed identityQualifiedPv identityQualifiedVisitors notCollected currentVersion flaggedPv flaggedUv
 edgeSamples edgeP50 edgeP95 originSamples originP50 originP95 edgeOverLimit originOverLimit unattributedOrigin cacheSamples hits rpm incompleteMinuteRequests unclassified`.split(
    /\s+/,
  ),
);
export const warehouseEvidenceRead = <T>(work: () => Promise<T>, signal?: AbortSignal) =>
  context.run({ signal }, work);
export const warehouseEvidenceSignal = () => context.getStore()?.signal;
const n = (sql: string) => `toFloat64(${sql})`;
const count = (condition?: string) => n(condition ? `countIf(${condition})` : 'count()');
const json = (field: string, ...keys: string[]) =>
  `JSONExtract(${field},${keys.map(key => `'${key}'`).join(',')},'Nullable(String)')`;
const measure = (key: string) => json('e.measurement', key);
const edge = (field: string, key: string) => json('e.edge_observation', 'fields', field, key);
export const warehouseSamplingRate = `if(${measure('samplingTimeBasis')}='event_time' AND ${measure('samplingBasis')}='observed_provider_config'
 AND JSONType(coalesce(e.measurement,'{}'),'samplingRate') IN('Int64','UInt64','Float64')
 AND JSONExtract(e.measurement,'samplingRate','Nullable(Float64)')>0 AND JSONExtract(e.measurement,'samplingRate','Nullable(Float64)')<=1,
 JSONExtract(e.measurement,'samplingRate','Nullable(Float64)'),NULL)`;

export function warehouseEvidenceScope(
  p: Pick<EvidenceQuery, 'startAt' | 'endAt' | 'timezone'> & Partial<EvidenceQuery>,
  recognized = true,
  verification = true,
  withEvidence = true,
) {
  const params: Record<string, unknown> = {
    evStart: warehouseTime(new Date(p.startAt)),
    evEnd: warehouseTime(new Date(p.endAt)),
    evTimezone: p.timezone,
  };
  const window = { start: 'evStart', end: 'evEnd', endExclusive: true };
  const logColumns = [
    'website_id',
    'id',
    'created_at',
    'source_id',
    'user_agent',
    'path',
    'method',
    'status',
    'bytes',
    'bot',
    'bot_type',
    'ai_eligible',
    'recognition_state',
    'verification',
    'verification_reason',
  ];
  const evidenceColumns = [
    'website_id',
    'log_id',
    'crawler_id',
    'measurement',
    'edge_observation',
    'cache_status',
    'duration_ms',
    'security_action',
    'terminating_rule_id',
    'matched_rule_ids',
  ];
  let sql = `FROM ${effectiveLogRelation({ immutableTimeWindow: window, columns: logColumns })} l ${withEvidence || p.botId ? `LEFT JOIN ${factRelation('liekan_crawler_evidence', { columns: evidenceColumns })} e ON e.website_id=l.website_id AND e.log_id=l.id` : ''}
    WHERE l.created_at>={evStart:DateTime64(6)} AND l.created_at<{evEnd:DateTime64(6)} AND l.user_agent NOT LIKE 'Liekan-Crawler-Check/%'`;
  if (p.population === 'ai_crawlers') sql += ` AND ${crawlerAiSql('l')}`;
  if (recognized && p.population !== 'all_logs') sql += ` AND NOT ${unknownCrawlerSql('l')}`;
  if (verification) sql += crawlerIdentitySql(p.crawlerIdentityScope, 'l');
  for (const [key, value, column] of [
    ['source', p.sourceId, 'l.source_id'],
    ['botId', p.botId, 'e.crawler_id'],
    ['botName', p.botName, 'l.bot'],
    ['botType', p.botType, 'l.bot_type'],
    ['path', p.path, 'l.path'],
  ] as const) {
    if (!value) continue;
    if (key === 'source' && value === 'manual') sql += ' AND l.source_id IS NULL';
    else {
      params[`ev_${key}`] = value;
      sql += ` AND ${column}={ev_${key}:${key === 'source' ? 'UUID' : 'String'}}`;
    }
  }
  if (p.recognitionGroup === 'ambiguous') sql += " AND l.recognition_state='ambiguous'";
  if (p.search) {
    params.evSearch = p.search;
    sql +=
      ' AND (positionCaseInsensitive(l.path,{evSearch:String})>0 OR positionCaseInsensitive(l.bot,{evSearch:String})>0)';
  }
  if (p.logFilter === 'ai') sql += ` AND ${crawlerAiSql('l')}`;
  if (p.logFilter === 'abnormal') sql += ' AND l.status>=400';
  if (p.logFilter === 'other') sql += ` AND ${unknownCrawlerSql('l')}`;
  return { sql, params };
}
async function rows<T = any>(site: string, sql: string, params: Record<string, unknown> = {}) {
  const result = await warehouseReportQuery<T>(site, sql, params, {
    signal: context.getStore()?.signal,
  });
  return result.map(row => warehouseEvidenceRow(row) as T);
}
export function warehouseEvidenceRow(row: any): any {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (value !== null && numericFields.has(key)) {
        const number = Number(value);
        if (!Number.isFinite(number) || (!/P(?:50|95)$/.test(key) && !Number.isSafeInteger(number)))
          throw new Error('warehouse-evidence-number-out-of-range');
        return [key, number];
      }
      if (value !== null && ['unsampled', 'hostObserved'].includes(key))
        return [key, !!Number(value)];
      return [
        key,
        value &&
        typeof value === 'string' &&
        ['time', 'lastVisit', 'firstEventAt', 'lastEventAt'].includes(key)
          ? new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z')
          : value,
      ];
    }),
  );
}

export async function warehouseEvidenceMeasurement(
  site: string,
  p: Pick<EvidenceQuery, 'startAt' | 'endAt' | 'timezone'> & Partial<EvidenceQuery>,
) {
  const scope = warehouseEvidenceScope(
    {
      ...p,
      population: 'all_logs',
      botId: undefined,
      botName: undefined,
      botType: undefined,
      path: undefined,
      search: undefined,
      logFilter: undefined,
      recognitionGroup: undefined,
    },
    false,
    false,
  );
  return (
    await rows(
      site,
      `SELECT ${count()} AS requests,${n(`uniqExact(${measure('sourceConfigVersion')})`)} AS versions,
    ${count(`${measure('sourceConfigVersion')} IS NOT NULL`)} AS samples,${n(`uniqExact(${measure('sourceIntervalVersion')})`)} AS intervals,
    minOrNull(${measure('sourceIntervalVersion')}) AS interval,${count(`${measure('sourceIntervalVersion')} IS NOT NULL`)} AS intervalSamples ${scope.sql}`,
      scope.params,
    )
  )[0];
}
export async function warehouseCrawlerEvidence(
  tx: AiTx,
  site: string,
  p: EvidenceQuery,
  input: EvidenceInputs,
) {
  const scope = warehouseEvidenceScope(p, true, true, p.view === 'matrix');
  if (p.view === 'summary') {
    const group =
      p.dimension === 'path'
        ? 'l.path'
        : p.dimension === 'day'
          ? "formatDateTime(l.created_at,'%Y-%m-%d',{evTimezone:String})"
          : 'l.bot';
    const sql = `SELECT ${group} AS name,${count()} AS requests,${n('uniqExact(l.path)')} AS pages,
      ${count("method='GET' AND status BETWEEN 200 AND 299")} AS get2xx,${count('status>=400')} AS abnormal,max(l.created_at) AS lastVisit
      ${scope.sql} GROUP BY name`;
    const order = p.sort === 'requests' ? `requests ${p.direction},name` : 'name';
    return {
      meta: evidenceMeta(p, input),
      rows: [],
      [warehouseEvidenceRows]: warehouseEvidenceTable(
        site,
        sql,
        scope.params,
        order,
        warehouseEvidenceRow,
      ),
    };
  }
  if (p.view === 'requests') {
    const responses = {
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
      scope.sql +=
        " AND if(verification IN('verified_range','verified_dns','verified_edge','range_mismatch'),verification,'unverified')={evVerification:String}";
      scope.params.evVerification = p.verificationGroup;
    }
    return {
      meta: evidenceMeta(p, input),
      rows: [],
      [warehouseEvidenceRows]: warehouseEvidenceTable(
        site,
        `SELECT l.id,l.created_at AS time,l.path,l.method,l.status,l.bot,l.verification ${scope.sql}`,
        scope.params,
        `path ${p.sort === 'path' ? p.direction : 'ASC'} COLLATE 'en',time DESC,id DESC`,
        warehouseEvidenceRow,
      ),
      outsideScope: [],
    };
  }
  const all = warehouseEvidenceScope(p, true, false);
  const matrix = await rows(
    site,
    `SELECT if(verification IN('verified_range','verified_dns','verified_edge','range_mismatch'),verification,'unverified') AS identity,
    multiIf(status<200,'1xx',status<300,'2xx',status=304,'304',status<400,'3xx',status IN(401,403,429,451),'denied',status<500,'other4xx','5xx') AS response,${count()} AS requests ${all.sql} GROUP BY identity,response ORDER BY identity,response`,
    all.params,
  );
  const owned = await tx.query<{ rule_id: string }>(
    `SELECT remote_rule_id AS rule_id FROM liekan_crawler_policy WHERE website_id=$1::uuid AND remote_rule_id IS NOT NULL
    UNION SELECT result->>'ruleId' FROM liekan_crawler_deployment WHERE website_id=$1::uuid AND result->>'ruleId' IS NOT NULL`,
    site,
  );
  const catalogProjection = await warehouseCatalogProjection(site, warehouseEvidenceSignal());
  const [totals] = await rows(
    site,
    `SELECT ${count()} AS requests,${count("method='GET' AND status BETWEEN 200 AND 299")} AS get2xx,
    ${count("method='GET' AND status IN(204,205)")} AS getNoBody,${count("method='GET' AND status=206")} AS getPartial,${count("method='HEAD'")} AS head,
    ${[401, 403, 429, 451].map(status => `${count(`status=${status}`)} AS status${status}`).join(',')},
    ${count("e.security_action='block' AND has({evOwned:Array(String)},coalesce(e.terminating_rule_id,''))")} AS ownedTerminatingBlocks,
    ${count("hasAny(JSONExtract(coalesce(e.matched_rule_ids,'[]'),'Array(String)'),{evOwned:Array(String)})")} AS ownedMatches,
    ${n(`uniqExactIf(l.path,l.path IN ${warehouseCatalogPaths})`)} AS requestedCatalogPaths,
    ${n(`uniqExactIf(l.path,method='GET' AND status BETWEEN 200 AND 299 AND l.path IN ${warehouseCatalogPaths})`)} AS respondedCatalogPaths ${scope.sql}`,
    {
      ...scope.params,
      evOwned: owned.map(r => r.rule_id),
      ...catalogProjection,
    },
  );
  const reasons = await rows(
    site,
    `SELECT coalesce(verification_reason,'legacy_unknown') AS reason,${count()} AS requests ${scope.sql} GROUP BY reason ORDER BY reason`,
    scope.params,
  );
  const ambiguous = warehouseEvidenceScope(
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
  const [ambiguousCount] = await rows(
    site,
    `SELECT ${count()} AS requests ${ambiguous.sql} AND l.recognition_state='ambiguous'`,
    ambiguous.params,
  );
  const selected = matrix.filter(
    row => p.crawlerIdentityScope === 'all' || row.identity === p.crawlerIdentityScope,
  );
  const [catalogCount] = await rows(
    site,
    `SELECT ${count()} AS requests FROM ${warehouseCatalogPaths} WHERE isNull({evCatalogPath:Nullable(String)}) OR path={evCatalogPath:Nullable(String)}`,
    { ...catalogProjection, evCatalogPath: p.path ?? null },
  );
  const denominator = catalogCount.requests;
  return {
    meta: evidenceMeta(p, input),
    rows: selected,
    outsideScope: matrix.filter(row => !selected.includes(row)),
    ambiguousRequests: ambiguousCount.requests,
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

export async function warehouseOutcomeLogs(
  site: string,
  p: EvidenceQuery,
  consume: (rows: any[]) => Promise<void>,
  signal?: AbortSignal,
) {
  const scope = warehouseEvidenceScope(p);
  return warehouseReportStream(
    site,
    `SELECT e.crawler_id,l.bot,l.path,${count()} AS requests,${count("method='GET' AND status BETWEEN 200 AND 299")} AS get2xx,
    if(count(${warehouseSamplingRate})=count(),min(${warehouseSamplingRate}=1),NULL) AS unsampled,
    min(coalesce(${measure('hostBasis')}='request_host',false)) AS hostObserved,minOrNull(${measure('host')}) AS host,
    ${n(`uniqExact(${measure('host')})`)} AS hosts,${n(`uniqExact(${measure('sourceConfigVersion')})`)} AS configs
    ${scope.sql} GROUP BY e.crawler_id,l.bot,l.path ORDER BY e.crawler_id,l.bot,l.path`,
    scope.params,
    batch => consume(batch.map(warehouseEvidenceRow)),
    signal ?? context.getStore()?.signal,
    true,
  );
}

export async function warehouseReconciliationFacts(
  site: string,
  p: ReconciliationQuery,
  hostname: string,
  input: EvidenceInputs,
  identityReady: boolean,
) {
  const scope = warehouseEvidenceScope(
    { ...p, population: 'all_logs', crawlerIdentityScope: 'all' },
    false,
  );
  const catalog = await warehouseCatalogHumanPaths(site, warehouseEvidenceSignal());
  const params = { ...scope.params, ...catalog, evHost: hostname, evPath: p.path ?? null };
  const mappingSQL = `SELECT humanPath,collisionPaths,if(isNull({evPath:Nullable(String)}),collisionPaths,arrayFilter(path->path={evPath:Nullable(String)},collisionPaths)) AS encodedPaths,
    length(collisionPaths)>1 AS ambiguous FROM (SELECT humanPath,arrayMap(pair->pair.2,arraySort(groupUniqArray(tuple(catalogOrder,encodedPath)))) AS collisionPaths FROM ${warehouseCatalogHumanRelation} GROUP BY humanPath)
    WHERE isNull({evPath:Nullable(String)}) OR has(collisionPaths,{evPath:Nullable(String)})`;
  const logs = `SELECT l.path,${count()} AS requests,${count("method='GET' AND status BETWEEN 200 AND 299")} AS get2xx,
    ${count(`method='GET' AND status BETWEEN 200 AND 299 AND NOT ${unknownCrawlerSql('l')}`)} AS crawler,
    ${count(`method='GET' AND status BETWEEN 200 AND 299 AND ${unknownCrawlerSql('l')}`)} AS candidate,
    ${count("recognition_state='ambiguous'")} AS ambiguousRequests,${count(`${edge('EdgeResponseContentType', 'state')}='present'`)} AS contentTypeSamples,
    ${count(`method='GET' AND status BETWEEN 200 AND 299 AND ${edge('EdgeResponseContentType', 'value')} IN('text/html','application/xhtml+xml')`)} AS confirmedHtml,
    ${count(`${measure('hostBasis')}='request_host' AND replaceRegexpOne(lower(trimRight(coalesce(${measure('host')},''),'.')),'^www[.]','')={evHost:String}`)} AS hostSamples,
    ${n(`uniqExact(${measure('sourceConfigVersion')})`)} AS configVersions,${count(`${measure('sourceConfigVersion')} IS NOT NULL`)} AS configSamples,
    ${count(`(${warehouseSamplingRate})=1`)} AS unsampledRequests ${scope.sql} AND l.path IN(SELECT arrayJoin(encodedPaths) FROM mapping) GROUP BY l.path`;
  const relation = `FROM ${websiteEventRelation()} e LEFT JOIN ${repairedQualityRelation()} q ON q.event_id=e.event_id AND q.website_id=e.website_id
    WHERE e.created_at>={evStart:DateTime64(6)} AND e.created_at<{evEnd:DateTime64(6)} AND e.event_type=1 AND e.url_path IN(SELECT humanPath FROM mapping)`;
  const counters = `${count()} AS pv,${n('uniqExact(e.session_id)')} AS uv,${n('uniqExact(tuple(e.visit_id,e.session_id))')} AS visits`;
  const [browserTotals] = await rows(
    site,
    `WITH mapping AS(${mappingSQL}) SELECT ${counters} ${relation} AND q.hostname={evHost:String}`,
    params,
  );
  const [unknown] = await rows(
    site,
    `WITH mapping AS(${mappingSQL}) SELECT ${count()} AS requests ${relation} AND q.hostname IS NULL`,
    params,
  );
  const [raw] = await rows(site, `SELECT ${count()} AS requests ${scope.sql}`, params);
  const presence = await warehouseBrowserConnected(site);
  const sums = [
    'requests',
    'get2xx',
    'crawler',
    'candidate',
    'ambiguousRequests',
    'contentTypeSamples',
    'confirmedHtml',
    'hostSamples',
    'configSamples',
    'unsampledRequests',
  ];
  const [catalogSize] = await rows(
    site,
    `WITH mapping AS(${mappingSQL}) SELECT ${count()} AS requests FROM mapping`,
    params,
  );
  const sql = `WITH mapping AS(${mappingSQL}),
    mapping_paths AS(SELECT humanPath,arrayJoin(encodedPaths) AS path FROM mapping),
    logs AS(${logs}), logged AS(SELECT m.humanPath AS mappedPath,${sums.map(key => `sum(coalesce(l.${key},0)) AS ${key}`).join(',')},
      max(coalesce(l.configVersions!=1,false)) AS configUnknown FROM mapping_paths m LEFT JOIN logs l ON l.path=m.path GROUP BY m.humanPath),
    browser AS(SELECT e.url_path AS path,${counters} ${relation} AND q.hostname={evHost:String} GROUP BY path),
    unknown_host AS(SELECT e.url_path AS path,${count()} AS unknownHostPv ${relation} AND q.hostname IS NULL GROUP BY path)
    SELECT m.*,${sums.map(key => `coalesce(l.${key},0) AS ${key}`).join(',')},coalesce(l.configUnknown,false) AS configUnknown,
      coalesce(b.pv,0) AS pv,coalesce(b.uv,0) AS uv,coalesce(b.visits,0) AS visits,coalesce(u.unknownHostPv,0) AS unknownHostPv
    FROM mapping m LEFT JOIN logged l ON l.mappedPath=m.humanPath LEFT JOIN browser b ON b.path=m.humanPath LEFT JOIN unknown_host u ON u.path=m.humanPath`;
  const map = (raw: any) => {
    const row = {
      ...raw,
      ...Object.fromEntries(
        [...sums, 'pv', 'uv', 'visits', 'unknownHostPv'].map(key => [key, Number(raw[key])]),
      ),
    };
    const requests = row.requests;
    const reason = row.ambiguous
      ? 'ambiguous_path'
      : !requests
        ? 'measurement_missing'
        : !presence.connected
          ? 'browser_missing'
          : row.unknownHostPv
            ? 'browser_host_unknown'
            : input.measurement.intervals !== 1 ||
                input.measurement.interval !== input.quality.sourceVersion ||
                input.measurement.intervalSamples !== input.measurement.requests ||
                input.measurement.versions !== 1 ||
                input.measurement.samples !== input.measurement.requests ||
                row.configSamples !== requests ||
                row.configUnknown
              ? 'source_config_unknown'
              : input.quality.state !== 'complete'
                ? 'source_coverage'
                : row.hostSamples !== requests
                  ? 'host_evidence'
                  : row.unsampledRequests !== requests
                    ? 'sampling_unknown'
                    : null;
    return {
      humanPath: row.humanPath,
      encodedPaths: row.encodedPaths,
      collisionPaths: row.collisionPaths,
      ambiguous: !!row.ambiguous,
      requests,
      get2xx: row.get2xx,
      crawler: row.crawler,
      candidate: row.candidate,
      ambiguousRequests: row.ambiguousRequests,
      confirmedHtml: row.confirmedHtml,
      contentType: evidenceValue(
        requests ? row.contentTypeSamples / requests : null,
        row.contentTypeSamples,
        requests,
        row.contentTypeSamples === requests && requests > 0
          ? 'available'
          : row.contentTypeSamples
            ? 'partial'
            : 'missing',
      ),
      observedPv: presence.connected ? row.pv : null,
      unknownHostPv: row.unknownHostPv,
      pv: presence.connected && !row.unknownHostPv ? row.pv : null,
      uv: identityReady && presence.connected && !row.unknownHostPv ? row.uv : null,
      visits: identityReady && presence.connected && !row.unknownHostPv ? row.visits : null,
      difference: evidenceValue(
        reason ? null : row.candidate - row.pv,
        row.hostSamples,
        requests,
        reason ? 'not_comparable' : 'available',
        reason,
      ),
    };
  };
  const order =
    p.sort === 'path'
      ? `humanPath ${p.direction} COLLATE 'en'`
      : `${p.sort === 'visits' ? (!identityReady || !presence.connected ? 'toUInt8(0)' : 'if(unknownHostPv>0,0,visits)') : p.sort} ${p.direction},humanPath ASC COLLATE 'en'`;
  const table = warehouseEvidenceTable(site, sql, params, order, map, {
    identityReady,
    browserConnected: presence.connected,
    measurement: input.measurement,
    qualityState: input.quality.state,
    qualitySourceVersion: input.quality.sourceVersion,
  });
  table.count = async () => catalogSize.requests;
  return {
    table,
    browserTotals,
    unknownHosts: unknown.requests,
    presence,
    rawRequests: raw.requests,
    catalogRows: catalogSize.requests,
  };
}

export async function warehouseObservationFacts(
  site: string,
  p: { startAt: number; endAt: number; subset: string },
  input: EvidenceInputs,
  start: Date,
) {
  const params = {
    evStart: warehouseTime(start),
    evEnd: warehouseTime(new Date(p.endAt)),
    obsVersion: OBSERVATION_VERSION,
    riskRule: BROWSER_RISK_VERSION,
    riskEpoch: String(input.baseline.epoch),
  };
  const population = `FROM ${factRelation('website_event')} e INNER JOIN ${factRelation('session')} s ON s.session_id=e.session_id AND s.website_id=e.website_id
    INNER JOIN ${factRelation('liekan_event_quality')} q ON q.event_id=e.event_id AND q.website_id=e.website_id
    LEFT JOIN ${factRelation('liekan_event_environment')} env ON env.event_id=e.event_id AND env.website_id=e.website_id
    LEFT JOIN ${factRelation('liekan_event_observation')} o ON o.event_id=e.event_id AND o.website_id=e.website_id
    WHERE e.event_type=1 AND q.source IN('browser','legacy_override') AND coalesce(o.received_at,q.created_at)>={evStart:DateTime64(6)}
    AND coalesce(o.received_at,q.created_at)<{evEnd:DateTime64(6)}
    ${p.subset === 'eligible' ? `AND e.event_id IN(SELECT event_id FROM ${websiteEventRelation()})` : ''}`;
  const dataSQL = `SELECT coalesce(s.browser,'unknown') AS browser,q.source,q.classification,coalesce(o.version,'not_collected') AS version,
    o.features,${count()} AS pv,${n('uniqExact(e.session_id)')} AS uv,count()<20 AS smallSample,min(e.created_at) AS firstEventAt,max(e.created_at) AS lastEventAt
    ${population} GROUP BY browser,q.source,q.classification,version,o.features`;
  const [totals] = await rows(
    site,
    `SELECT ${count()} AS pv,${n('uniqExact(e.session_id)')} AS uv,${n('uniqExact(tuple(e.visit_id,e.session_id))')} AS visits,
    ${n('count(o.event_id)')} AS observed,${count("env.scope='browser' AND env.identity_available")} AS identityQualifiedPv,
    ${n("uniqExactIf(e.session_id,env.scope='browser' AND env.identity_available)")} AS identityQualifiedVisitors,
    arraySort(groupUniqArray(env.identity_version)) AS identityVersions,${count('o.event_id IS NULL')} AS notCollected,${count('o.version={obsVersion:String}')} AS currentVersion
    ${population}`,
    params,
  );
  // Join the accepted risk proof on session/visit; count event IDs so multiple
  // observed risk windows can never duplicate one received page view.
  const [behavior] = await rows(
    site,
    `WITH received AS (SELECT e.event_id,e.session_id,e.visit_id,q.created_at AS received_at ${population})
    SELECT ${n('uniqExact(e.event_id)')} AS flaggedPv,${n('uniqExact(e.session_id)')} AS flaggedUv FROM received e
    INNER JOIN ${riskRelation()} r ON r.session_id=e.session_id AND r.visit_id=e.visit_id
    WHERE e.received_at<=r.window_end AND e.received_at>r.window_end-INTERVAL 5 MINUTE`,
    params,
  );
  const fields = ['accept', 'language', 'site', 'mode', 'dest'];
  const [fieldSamples] = await rows(
    site,
    `SELECT ${fields.map(field => `${count(`JSONExtractString(coalesce(o.features,'{}'),'${field}','state')='present'`)} AS ${field}`).join(',')} ${population}`,
    params,
  );
  const identityReady = !totals.pv || totals.identityQualifiedPv === totals.pv;
  const table = warehouseEvidenceTable(
    site,
    dataSQL,
    params,
    'browser,source,classification,version,features',
    raw => {
      const row = warehouseEvidenceRow(raw);
      return {
        ...row,
        uv: identityReady ? row.uv : null,
        smallSample: !!row.smallSample,
        features: row.features ? JSON.parse(row.features) : null,
      };
    },
  );
  return { rows: [], table, totals, behavior, fieldSamples };
}

export async function warehousePerformanceFacts(
  site: string,
  p: EvidenceQuery,
  knownCache: string[],
) {
  const scope = warehouseEvidenceScope(p);
  const raw = (field: string) =>
    `nullIf(JSONExtractRaw(e.edge_observation,'fields','${field}','value'),'null')`;
  const projection = `SELECT l.created_at,l.bytes,e.measurement,lower(e.cache_status) AS cache,e.edge_observation,
    if(${edge('edgeDurationMs', 'state')}='present',toFloat64OrNull(${raw('edgeDurationMs')}),e.duration_ms) AS edge_ms,
    if(${edge('OriginResponseDurationMs', 'state')}='present' AND toInt32OrNull(${raw('OriginResponseStatus')}) BETWEEN 100 AND 599,
      toFloat64OrNull(${raw('OriginResponseDurationMs')}),NULL) AS origin_ms ${scope.sql}`;
  const field = (name: string, key: string) => json('edge_observation', 'fields', name, key);
  const [totals] = await rows(
    site,
    `WITH selected AS (${projection}) SELECT ${count()} AS requests,${n('count(edge_ms)')} AS edgeSamples,
    quantileExactInclusiveOrNull(0.5)(edge_ms) AS edgeP50,quantileExactInclusiveOrNull(0.95)(edge_ms) AS edgeP95,
    ${n('count(origin_ms)')} AS originSamples,quantileExactInclusiveOrNull(0.5)(origin_ms) AS originP50,quantileExactInclusiveOrNull(0.95)(origin_ms) AS originP95,
    ${count(`${field('edgeDurationMs', 'reason')}='over_limit'`)} AS edgeOverLimit,${count(`${field('OriginResponseDurationMs', 'reason')}='over_limit'`)} AS originOverLimit,
    ${count("JSONExtractRaw(edge_observation,'fields','OriginResponseStatus','value')='0'")} AS unattributedOrigin,
    ${count('has({evCache:Array(String)},cache)')} AS cacheSamples,${count("cache IN('hit','stream_hit')")} AS hits FROM selected`,
    { ...scope.params, evCache: knownCache },
  );
  const unit = `coalesce(${json('measurement', 'bytesUnit')},'unknown')`,
    available = `${json('measurement', 'bytesAvailability')}='present'`;
  const data = await rows(
    site,
    `WITH selected AS (${projection}),bytes_totals AS (SELECT ${unit} AS unit,${count()} AS requests,
    ${count(available)} AS samples,sumOrNullIf(toDecimal128(bytes,0),${available}) AS observedBytes FROM selected GROUP BY unit),
    minutes AS (SELECT ${unit} AS unit,toStartOfMinute(created_at) AS minute,sumOrNullIf(toDecimal128(bytes,0),${available}) AS bytes FROM selected GROUP BY unit,minute)
    SELECT b.unit,b.requests,b.samples,toString(b.observedBytes) AS observedBytes,
    toString(maxOrNullIf(m.bytes,m.minute>={evStart:DateTime64(6)} AND m.minute+INTERVAL 60 SECOND<={evEnd:DateTime64(6)})) AS peakMinuteBytes,
    toString(divideDecimal(toDecimal256(maxOrNullIf(m.bytes,m.minute>={evStart:DateTime64(6)} AND m.minute+INTERVAL 60 SECOND<={evEnd:DateTime64(6)}),0),toDecimal256(60,0),20)) AS observedPeakBytesPerSecond
    FROM bytes_totals b LEFT JOIN minutes m ON b.unit=m.unit GROUP BY b.unit,b.requests,b.samples,b.observedBytes ORDER BY b.unit`,
    scope.params,
  );
  const [peak] = await rows(
    site,
    `WITH minutes AS(SELECT toStartOfMinute(l.created_at) AS minute,${count()} AS requests ${scope.sql} GROUP BY minute)
    SELECT maxOrNullIf(requests,minute>={evStart:DateTime64(6)} AND minute+INTERVAL 60 SECOND<={evEnd:DateTime64(6)}) AS rpm,
    coalesce(sumIf(requests,minute<{evStart:DateTime64(6)} OR minute+INTERVAL 60 SECOND>{evEnd:DateTime64(6)}),0) AS incompleteMinuteRequests FROM minutes`,
    scope.params,
  );
  const cacheTable = warehouseEvidenceTable(
    site,
    `SELECT coalesce(lower(e.cache_status),'missing') AS status,${count()} AS requests ${scope.sql} GROUP BY status`,
    scope.params,
    'status',
    warehouseEvidenceRow,
  );
  const fieldCoverageTable = warehouseEvidenceTable(
    site,
    `WITH selected AS (${projection}) SELECT field,coalesce(JSONExtract(edge_observation,'fields',field,'state','Nullable(String)'),'unknown') AS state,
    if(field IN('OriginResponseDurationMs','edgeDurationMs'),NULL,nullIf(JSONExtractRaw(edge_observation,'fields',field,'value'),'')) AS value,
    ${count()} AS requests FROM selected ARRAY JOIN ['BotScore','BotScoreSrc','VerifiedBotCategory','EdgeResponseContentType','OriginResponseDurationMs','OriginResponseStatus','edgeDurationMs'] AS field
    GROUP BY field,state,value`,
    scope.params,
    'field,state,value',
    raw => {
      const row = warehouseEvidenceRow(raw);
      return { ...row, value: row.value === null ? null : JSON.parse(row.value) };
    },
  );
  return { totals, rows: data, peak, cache: [], fieldCoverage: [], cacheTable, fieldCoverageTable };
}

export async function warehouseHistoricalImpact(
  site: string,
  body: { botIds: string[]; paths: { value: string; match: string }[] },
) {
  const [counts] = await rows(
    site,
    `SELECT ${count(`has({impactBots:Array(String)},coalesce(e.crawler_id,'')) AND arrayExists(p->l.path=p.1 OR
    (p.2='prefix' AND startsWith(l.path,if(endsWith(p.1,'/'),p.1,concat(p.1,'/')))),arrayZip({impactPaths:Array(String)},{impactMatches:Array(String)}))`)} AS requests,
    ${count('e.crawler_id IS NULL')} AS unclassified,${count()} AS observed
    FROM ${effectiveLogRelation({ immutableTimeWindow: { start: 'impactStart', end: 'impactEnd' }, columns: ['website_id', 'id', 'created_at', 'source_id', 'path'] })} l LEFT JOIN ${factRelation('liekan_crawler_evidence', { columns: ['website_id', 'log_id', 'crawler_id'] })} e ON e.website_id=l.website_id AND e.log_id=l.id
    WHERE l.created_at>={impactStart:DateTime64(6)} AND l.created_at<={impactEnd:DateTime64(6)}`,
    {
      impactBots: body.botIds,
      impactPaths: body.paths.map(p => p.value),
      impactMatches: body.paths.map(p => p.match),
      impactStart: warehouseTime(new Date(Date.now() - 7 * 86400000)),
      impactEnd: warehouseTime(new Date()),
    },
  );
  return {
    requests: counts.observed ? counts.requests : null,
    observedRequests: counts.observed,
    state: !counts.observed ? 'missing' : counts.unclassified ? 'partial' : 'available',
    unclassified: counts.unclassified,
    basis: 'historical_estimate' as const,
    windowDays: 7,
  };
}
