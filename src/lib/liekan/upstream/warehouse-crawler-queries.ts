import type { CrawlerIdentityScope } from '../contracts/crawler-metrics';
import type { CrawlerAnalyzedBot, CrawlerAnalyzedPage } from '../contracts/crawler-analysis';
import { crawlerIdentitySql } from '../crawlers/metric-scope';
import { unknownCrawlerSql } from '../rules/population';
import { warehouseTime } from '../warehouse/fact-input';
import { factRelation } from '../warehouse/read';
import { effectiveLogRelation, reportingLogRelation } from '../warehouse/reporting-relations';
import type { AiTx } from './ai-db';
import { warehouseCatalogPaths, warehouseCatalogProjection } from './warehouse-catalog';
import { warehouseReportQuery } from './warehouse-report-snapshot';

const numeric = new Set([
  'requests',
  'status1xx',
  'status2xx',
  'status3xx',
  'status304',
  'status4xx',
  'status5xx',
  'denied403429',
  'head',
  'successfulGets',
  'bytes',
  'verifiedRange',
  'verifiedDns',
  'verifiedEdge',
  'rangeMismatch',
  'unverified',
  'successfulCatalogPages',
  'legacyRecords',
  'ownedTerminatingBlocks',
  'ownedMatches',
  'mismatches',
  'sensitive',
  'intentional',
  'classes',
  'legacy',
  'sources',
  'denied',
  'owned',
  'current',
  'previous',
]);
async function crawlerQuery<T>(
  site: string,
  sql: string,
  params: Record<string, unknown>,
): Promise<T[]> {
  return (await warehouseReportQuery<Record<string, unknown>>(site, sql, params)).map(
    row =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => {
          if (!numeric.has(key) || value === null) return [key, value];
          const n = Number(value);
          if (!Number.isSafeInteger(n) || n < 0)
            throw new Error('warehouse-crawler-counter-out-of-range');
          return [key, n];
        }),
      ) as T,
  );
}
const time = {
  immutableTimeWindow: { start: 'crawlerStart', end: 'crawlerEnd', endExclusive: true },
} as const;
export const warehouseCrawlerBase = (
  reporting = false,
) => `FROM ${reporting ? reportingLogRelation(time) : effectiveLogRelation(time)} l
  LEFT JOIN ${factRelation('liekan_crawler_evidence')} e ON e.website_id=l.website_id AND e.log_id=l.id
  WHERE l.user_agent NOT LIKE 'Liekan-Crawler-Check/%'`;
export const warehouseCrawlerCounts = `toFloat64(count()) AS requests,
  toFloat64(countIf(status>=100 AND status<200)) AS status1xx,toFloat64(countIf(status>=200 AND status<300)) AS status2xx,
  toFloat64(countIf(status>=300 AND status<400 AND status!=304)) AS status3xx,toFloat64(countIf(status=304)) AS status304,
  toFloat64(countIf(status>=400 AND status<500)) AS status4xx,toFloat64(countIf(status>=500 AND status<600)) AS status5xx,
  toFloat64(countIf(status IN(403,429))) AS denied403429,toFloat64(countIf(method='HEAD')) AS head,
  toFloat64(countIf(method='GET' AND status>=200 AND status<300)) AS successfulGets`;
export const warehouseCrawlerRange = (start: number, end: number) => ({
  crawlerStart: warehouseTime(new Date(start)),
  crawlerEnd: warehouseTime(new Date(end)),
});
export const warehouseOwnedBlock =
  "e.security_action='block' AND has({ownedRules:Array(String)},coalesce(e.terminating_rule_id,''))";
export const warehouseOwnedMatch =
  "arrayExists(rule->has(JSONExtract(coalesce(e.matched_rule_ids,'[]'),'Array(String)'),rule),{ownedRules:Array(String)})";
export const warehouseIntentionalBlock = `${warehouseOwnedBlock} AND arrayExists((rule,start,end)->rule=e.terminating_rule_id
  AND parseDateTime64BestEffort(start,6,'UTC')<=l.created_at AND (end='' OR l.created_at<parseDateTime64BestEffortOrNull(end,6,'UTC')),
  {blockedRules:Array(String)},{blockedStarts:Array(String)},{blockedEnds:Array(String)})`;
export async function warehouseCrawlerControl(tx: AiTx, site: string) {
  const rules = await tx.query<{ rule: string }>(
    `SELECT remote_rule_id AS rule FROM liekan_crawler_policy WHERE website_id=$1::uuid AND remote_rule_id IS NOT NULL
    UNION SELECT result->>'ruleId' FROM liekan_crawler_deployment WHERE website_id=$1::uuid AND result->>'ruleId' IS NOT NULL ORDER BY rule`,
    site,
  );
  const blocked = await tx.query<{ rule: string; starts: string; ends: string | null }>(
    `SELECT d.result->>'ruleId' AS rule,
    to_char((d.completed_at+interval '5 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS starts,
    to_char((SELECT min(later.created_at)-interval '5 minutes' FROM liekan_crawler_deployment later WHERE later.policy_id=d.policy_id
      AND later.created_at>d.created_at AND coalesce(later.target->>'mode','apply')!='adopt'
      AND later.state IN('running','confirmed','unknown','conflict','cleanup')) AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS ends
    FROM liekan_crawler_deployment d WHERE d.website_id=$1::uuid AND d.state='confirmed' AND d.operation IN('deploy','rollback')
      AND coalesce(d.target->>'mode','apply')!='adopt' AND d.result->>'ruleId' IS NOT NULL AND d.target->'body'->>'action'='block'
      AND d.target->'body'->>'expectedAccess'='block' AND d.target->'rule'->>'enabled'='true' AND d.completed_at IS NOT NULL
    ORDER BY d.id`,
    site,
  );
  return {
    ownedRules: rules.map(r => r.rule),
    blockedRules: blocked.map(r => r.rule),
    blockedStarts: blocked.map(r => r.starts),
    blockedEnds: blocked.map(r => r.ends ?? ''),
  };
}
export async function warehouseCrawlerBots(
  site: string,
  start: number,
  end: number,
  scope: CrawlerIdentityScope = 'all',
  detail = true,
) {
  const params = {
    ...warehouseCrawlerRange(start, end),
    ...(detail ? await warehouseCatalogProjection(site) : {}),
  };
  const rows = await crawlerQuery<CrawlerAnalyzedBot & { lastVisit?: string }>(
    site,
    `SELECT l.reporting_crawler_id AS botId,l.bot AS name,${warehouseCrawlerCounts},toFloat64(sum(bytes)) AS bytes
    ${
      detail
        ? `,toFloat64(countIf(verification='verified_range')) AS verifiedRange,toFloat64(countIf(verification='verified_dns')) AS verifiedDns,
      toFloat64(countIf(verification='verified_edge')) AS verifiedEdge,toFloat64(countIf(verification='range_mismatch')) AS rangeMismatch,
      toFloat64(countIf(verification NOT IN('verified_range','verified_dns','verified_edge','range_mismatch'))) AS unverified,
      toFloat64(uniqExactIf(path,method='GET' AND status>=200 AND status<300 AND path IN ${warehouseCatalogPaths})) AS successfulCatalogPages,
      toString(max(created_at)) AS lastVisit,toFloat64(countIf(isNull(l.reporting_classification_version))) AS legacyRecords`
        : ''
    }
    ${warehouseCrawlerBase(true)}${crawlerIdentitySql(scope, 'l')} AND NOT ${unknownCrawlerSql('l')} GROUP BY botId,name ORDER BY requests DESC,botId,name`,
    params,
  );
  return rows.map(row => ({
    ...row,
    ...(detail
      ? {
          lastVisit: row.lastVisit
            ? new Date(row.lastVisit.replace(' ', 'T') + 'Z').toISOString()
            : null,
        }
      : {}),
  }));
}
export async function warehouseCrawlerPages(
  tx: AiTx,
  site: string,
  start: number,
  end: number,
  scope: CrawlerIdentityScope = 'all',
) {
  return crawlerQuery<CrawlerAnalyzedPage>(
    site,
    `SELECT l.reporting_crawler_id AS botId,path,l.bot AS name,${warehouseCrawlerCounts},toFloat64(sum(bytes)) AS bytes,
    toFloat64(countIf(${warehouseOwnedBlock})) AS ownedTerminatingBlocks,toFloat64(countIf(${warehouseOwnedMatch})) AS ownedMatches
    ${warehouseCrawlerBase(true)}${crawlerIdentitySql(scope, 'l')} AND NOT ${unknownCrawlerSql('l')} GROUP BY botId,path,name ORDER BY requests DESC,path,botId LIMIT 1001`,
    { ...warehouseCrawlerRange(start, end), ...(await warehouseCrawlerControl(tx, site)) },
  );
}

export async function warehouseCrawlerHours(tx: AiTx, site: string, start: number, end: number) {
  const rows = await crawlerQuery<Record<string, any>>(
    site,
    `SELECT e.crawler_id AS botId,toString(toStartOfHour(l.created_at)) AS hour,${warehouseCrawlerCounts},
    toFloat64(countIf(verification='range_mismatch')) AS mismatches,
    toFloat64(countIf(match(path,{sensitivePattern:String}))) AS sensitive,
    toFloat64(countIf(status IN(403,429) AND ${warehouseIntentionalBlock})) AS intentional
    ${warehouseCrawlerBase()} AND isNotNull(e.crawler_id) GROUP BY botId,hour ORDER BY hour,botId`,
    {
      ...warehouseCrawlerRange(start, end),
      ...(await warehouseCrawlerControl(tx, site)),
      sensitivePattern: '^/(\\.env($|[./])|\\.git($|/)|wp-config[.]php$)',
    },
  );
  return rows.map(row => ({ ...row, hour: new Date(row.hour.replace(' ', 'T') + 'Z') }));
}
export async function warehouseCrawlerHourMetadata(site: string, start: number, end: number) {
  const rows = await crawlerQuery<{
    hour: string;
    classes: number;
    classification: string | null;
    legacy: number;
    sources: number;
    source: string | null;
  }>(
    site,
    `SELECT toString(toStartOfHour(l.created_at)) AS hour,
    toFloat64(uniqExact(coalesce(e.classification_version,'legacy'))) AS classes,min(e.classification_version) AS classification,
    toFloat64(countIf(isNull(e.classification_version))) AS legacy,toFloat64(uniqExact(coalesce(toString(l.source_id),'manual'))) AS sources,min(toString(l.source_id)) AS source
    ${warehouseCrawlerBase()} GROUP BY hour ORDER BY hour`,
    warehouseCrawlerRange(start, end),
  );
  return rows.map(row => ({ ...row, hour: new Date(row.hour.replace(' ', 'T') + 'Z') }));
}
export async function warehouseCrawlerExpected(
  tx: AiTx,
  site: string,
  start: number,
  end: number,
  critical: string[],
) {
  const expectations = await tx.query<{
    path: string;
    match: string;
    bot_id: string | null;
    expected_access: string;
    since: string | null;
    kind: string;
  }>(
    `SELECT value AS path,'exact' AS match,NULL::text AS bot_id,'allow' AS expected_access,NULL::text AS since,'critical' AS kind
    FROM jsonb_array_elements_text($2::jsonb)
    UNION SELECT selector->>'value',selector->>'match',bot_id,p.body->>'expectedAccess',to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US'),'policy'
      FROM liekan_crawler_policy p JOIN liekan_crawler_state state ON state.website_id=p.website_id AND state.generation=p.generation,
      jsonb_array_elements(p.body->'paths') selector,jsonb_array_elements_text(p.body->'botIds') bot_id WHERE p.website_id=$1::uuid ORDER BY 1,2,3,4,5,6`,
    site,
    JSON.stringify(critical),
  );
  if (!expectations.length) return [];
  const base = warehouseCrawlerBase().replace(
    'WHERE l.user_agent',
    `CROSS JOIN (SELECT JSONExtractString(j,'path') AS path,JSONExtractString(j,'match') AS match,
    JSONExtract(j,'bot_id','Nullable(String)') AS bot,JSONExtractString(j,'expected_access') AS expected,
    parseDateTime64BestEffortOrNull(JSONExtractString(j,'since'),6,'UTC') AS since,JSONExtractString(j,'kind') AS kind
    FROM (SELECT arrayJoin({expectations:Array(String)}) AS j)) x WHERE l.user_agent`,
  );
  return crawlerQuery<Record<string, any>>(
    site,
    `SELECT e.crawler_id AS botId,x.path AS path,x.expected AS expectedAccess,
    toBool(max(x.kind='critical')) AS publicKeyPath,toFloat64(countIf(verification IN('verified_range','verified_dns','verified_edge') AND status IN(403,429)
      AND NOT coalesce(${warehouseIntentionalBlock},false))) AS denied,
    toFloat64(countIf(${warehouseOwnedBlock} AND (x.kind='policy' OR NOT coalesce(${warehouseIntentionalBlock},false)))) AS owned
    ${base} AND isNotNull(e.crawler_id) AND (isNull(x.bot) OR x.bot=e.crawler_id) AND (isNull(x.since) OR l.created_at>=x.since)
      AND (l.path=x.path OR (x.match='prefix' AND (x.path='/' OR startsWith(l.path,concat(trimRight(x.path,'/'),'/')))))
    GROUP BY botId,path,expectedAccess ORDER BY owned DESC,denied DESC,botId,path,expectedAccess`,
    {
      ...warehouseCrawlerRange(start, end),
      ...(await warehouseCrawlerControl(tx, site)),
      expectations: expectations.map(row => JSON.stringify(row)),
    },
  );
}

export async function warehouseCrawlerCoverage(
  site: string,
  start: number,
  end: number,
  midpoint: number,
  paths: string[],
) {
  if (!paths.length) return [];
  return crawlerQuery<Record<string, any>>(
    site,
    `SELECT e.crawler_id AS botId,path,
    toFloat64(countIf(created_at>={midpoint:DateTime64(6,'UTC')})) AS current,toFloat64(countIf(created_at<{midpoint:DateTime64(6,'UTC')})) AS previous
    ${warehouseCrawlerBase()} AND method='GET' AND status>=200 AND status<300 AND isNotNull(e.crawler_id) AND has({coveragePaths:Array(String)},path) GROUP BY botId,path`,
    {
      ...warehouseCrawlerRange(start, end),
      midpoint: warehouseTime(new Date(midpoint)),
      coveragePaths: paths,
    },
  );
}
