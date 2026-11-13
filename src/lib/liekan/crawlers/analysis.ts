import { z } from 'zod';
import { type BrowserPopulation, identityUsable } from '../contracts/browser-population';
import type { CrawlerAnalyzedBot, CrawlerAnalyzedPage } from '../contracts/crawler-analysis';
import type { CrawlerIdentityScope } from '../contracts/crawler-metrics';
import type { CrawlerObservationQuality } from '../contracts/crawlers';
import { crawlerPathSchema } from '../contracts/crawlers';
import {
  classifyEntrySource,
  platformForReferral,
  platformHasReferrals,
} from '../contracts/sources';
import { CRAWLER_POPULATION_VERSION, unknownCrawlerSql } from '../rules/population';
import type { AiTx } from '../upstream/ai-db';
import { crawlerReferralRows } from '../upstream/analytics';
import { readTransactionBrowserPopulation } from '../upstream/browser-population';
import { noteBrowserPopulation, noteCacheResult } from '../upstream/cache-context';
import {
  authorizeCrawler,
  type CrawlerActor,
  crawlerTransaction,
} from '../upstream/crawler-access';
import { withPublishedRegistry } from '../upstream/crawler-registry-context';
import { LiekanError } from '../upstream/errors';
import { humanPathFromEncoded } from '../upstream/paths';
import { analyticsCache, analyticsCacheKey, websiteCacheTag } from '../upstream/query-cache';
import { TRAFFIC_POLICY_VERSION } from '../upstream/traffic-query';
import { crawlerDirectoryForObserved } from './directory';
import { crawlerOwnedBlock, crawlerOwnedMatch } from './execution';
import { crawlerIdentitySql } from './metric-scope';
import { getCrawlerPlatformIds } from './registry';
import { warehouseEnabled } from '../warehouse/runtime';
import { withinWarehouseReport, warehouseReportMetadata, warehouseReportQuery } from '../upstream/warehouse-report-snapshot';
import { factRelation } from '../warehouse/read';
import { warehouseControlRead } from '../upstream/warehouse-control-read';
import { warehouseCrawlerBots, warehouseCrawlerPages } from '../upstream/warehouse-crawler-queries';

const DAY = 86_400_000;
export const crawlerCriticalPathsSchema = z.strictObject({
  paths: z
    .array(crawlerPathSchema.shape.value)
    .max(100)
    .refine(paths => new Set(paths).size === paths.length),
});
export function crawlerRange(search: URLSearchParams, now = Date.now()) {
  const requestedEnd = search.has('endAt') ? Number(search.get('endAt')) : now;
  const requestedStart = search.has('startAt')
    ? Number(search.get('startAt'))
    : requestedEnd - 7 * DAY;
  const live = requestedEnd <= now && requestedEnd > now - 30000;
  const endAt = live ? Math.floor(requestedEnd / 30000) * 30000 : requestedEnd;
  const startAt = live ? requestedStart - (requestedEnd - endAt) : requestedStart;
  const timezone = search.get('timezone') || 'UTC';
  if (
    !Number.isSafeInteger(requestedStart) ||
    !Number.isSafeInteger(requestedEnd) ||
    !Number.isSafeInteger(startAt) ||
    !Number.isSafeInteger(endAt) ||
    startAt < 0 ||
    endAt > now ||
    startAt >= endAt ||
    endAt - startAt > 90 * DAY
  )
    throw new LiekanError('分析时间范围需要在过去 90 天内', 400);
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new LiekanError('时区无效', 400);
  }
  return { startAt, endAt, timezone };
}

export const crawlerBase = `FROM liekan_effective_log l LEFT JOIN liekan_crawler_evidence e ON e.website_id=l.website_id AND e.log_id=l.id
  WHERE l.website_id=$1::uuid AND l.created_at>=$2::timestamptz AND l.created_at<$3::timestamptz AND l.user_agent NOT LIKE 'Liekan-Crawler-Check/%'`;
const reportingCrawlerBase = crawlerBase.replace('liekan_effective_log', 'liekan_reporting_log');
export const crawlerCountColumns = `count(*)::float8 AS requests,
  count(*) FILTER(WHERE status>=100 AND status<200)::float8 AS "status1xx",
  count(*) FILTER(WHERE status>=200 AND status<300)::float8 AS "status2xx",
  count(*) FILTER(WHERE status>=300 AND status<400 AND status!=304)::float8 AS "status3xx",
  count(*) FILTER(WHERE status=304)::float8 AS "status304",
  count(*) FILTER(WHERE status>=400 AND status<500)::float8 AS "status4xx",
  count(*) FILTER(WHERE status>=500 AND status<600)::float8 AS "status5xx",
  count(*) FILTER(WHERE status IN(403,429))::float8 AS "denied403429",
  count(*) FILTER(WHERE method='HEAD')::float8 AS head,
  count(*) FILTER(WHERE method='GET' AND status>=200 AND status<300)::float8 AS "successfulGets"`;

export interface CrawlerWindowVersions {
  classes: number;
  classification: string | null;
  sources: number;
  source: string | null;
  legacy: number;
}
export async function crawlerWindowQuality(
  tx: AiTx,
  websiteId: string,
  startAt: number,
  endAt: number,
  timezone: string,
  sourceId?: string,
  acceptedVersions?: CrawlerWindowVersions,
): Promise<CrawlerObservationQuality> {
  const args = [websiteId, new Date(startAt), new Date(endAt), ...(sourceId ? [sourceId] : [])];
  const sourceFilter = sourceId ? ' AND source_id=$4::uuid' : '';
  const [versions] =
    acceptedVersions !== undefined && warehouseEnabled() && !sourceId
      ? [acceptedVersions]
      : warehouseEnabled()
      ? [
          await (await import('../upstream/warehouse-geo-weight')).warehouseCrawlerWindowVersions(
            websiteId,
            startAt,
            endAt,
            sourceId,
          ),
        ]
      : await tx.query(
          `SELECT count(distinct coalesce(e.classification_version,'legacy'))::int AS classes,
    min(e.classification_version) AS classification,count(distinct coalesce(l.source_id::text,'manual'))::int AS sources,min(l.source_id::text) AS source,
    count(*) FILTER(WHERE e.classification_version IS NULL)::int AS legacy ${crawlerBase}${sourceId ? ' AND l.source_id=$4::uuid' : ''}`,
          ...args,
        );
  const [gap] = await tx.query(
    `SELECT count(*)::int AS count FROM liekan_crawler_quality WHERE website_id=$1::uuid AND starts_at<$3 AND ends_at>$2 AND state='partial'${sourceFilter}`,
    ...args,
  );
  const [backlog] = await tx.query(
    `SELECT count(*)::int AS count FROM liekan_ingest_batch WHERE website_id=$1::uuid AND state='pending'${sourceId ? ' AND source_id=$2::uuid' : ''}`,
    websiteId,
    ...(sourceId ? [sourceId] : []),
  );
  const declarations = await tx.query(
    `SELECT source_id AS source,evidence->>'classificationVersion' AS classification,evidence->>'sourceVersion' AS source_version,
    range_agg(tstzrange(starts_at,ends_at,'[]')) @> tstzrange($2::timestamptz,$3::timestamptz,'[)') AS covers
    FROM liekan_crawler_quality WHERE website_id=$1::uuid AND state='complete' AND evidence->>'basis'='event_time'
      AND starts_at<$3 AND ends_at>$2${sourceFilter} GROUP BY source_id,evidence->>'classificationVersion',evidence->>'sourceVersion'`,
    ...args,
  );
  const valid = declarations.filter(row => row.covers && row.classification);
  const declaration = valid.length === 1 ? valid[0] : null;
  const complete =
    !!declaration &&
    (!versions?.classes ||
      (versions.classes === 1 &&
        !versions.legacy &&
        versions.sources === 1 &&
        versions.source === declaration.source &&
        versions.classification === declaration.classification));

  return {
    state: gap?.count
      ? 'partial'
      : backlog.count
        ? 'unknown'
        : complete
          ? 'complete'
          : !versions?.classes
            ? 'missing'
            : 'unknown',
    basis: 'event_time',
    classificationVersion:
      versions?.classes === 1 && !versions?.legacy
        ? versions.classification || ''
        : !versions?.classes
          ? declaration?.classification || ''
          : '',
    sourceVersion: complete
      ? declaration.source_version
      : versions?.sources === 1
        ? versions.source || 'manual'
        : !versions?.classes
          ? declaration?.source_version || ''
          : '',
    timezone,
  };
}
const platformForSource = (source: string) => platformForReferral(source)?.id ?? null;
async function crawlerAnalysisSnapshot(
  actor: CrawlerActor,
  websiteId: string,
  range: ReturnType<typeof crawlerRange>,
  identityScope: CrawlerIdentityScope = 'all',
) {
  const access = await crawlerTransaction(async tx => {
    const website = await authorizeCrawler(tx, actor, websiteId);
    const [state] = await tx.query(
      'SELECT epoch,data_revision FROM liekan_log_state WHERE website_id=$1::uuid',
      websiteId,
    );
    return {
      website,
      version: {
        epoch: state?.epoch ?? 1,
        revision: String(state?.data_revision ?? 0),
        browserRevision: String(
          (
            await tx.query(
              "SELECT revision::text FROM liekan_analytics_revision WHERE resource_type='website' AND resource_id=$1::uuid",
              websiteId,
            )
          )[0]?.revision ?? 0,
        ),
      },
    };
  });
  const cached = await analyticsCache.read(
    analyticsCacheKey('crawler-analysis-identity-v1-' + CRAWLER_POPULATION_VERSION, {
      websiteId,
      ...range,
      identityScope,
      populationVersion: TRAFFIC_POLICY_VERSION,
      ...access.version,
      ...(warehouseEnabled() ? {warehouse: await warehouseReportMetadata(websiteId)} : {}),
    }),
    30000,
    [websiteCacheTag(websiteId)],
    () =>
      (warehouseEnabled() ? warehouseCrawlerRead : crawlerTransaction)(
        async tx => {
          await authorizeCrawler(tx, actor, websiteId);
          const { startAt, endAt, timezone } = range;
          const args = [websiteId, new Date(startAt), new Date(endAt)];
          const quality = await crawlerWindowQuality(tx, websiteId, startAt, endAt, timezone);
          const bots = warehouseEnabled() ? await warehouseCrawlerBots(websiteId,startAt,endAt,identityScope) : await tx.query<CrawlerAnalyzedBot>(
            `SELECT l.reporting_crawler_id AS "botId",l.bot AS name,${crawlerCountColumns},sum(bytes)::float8 AS bytes,
      count(*) FILTER(WHERE verification='verified_range')::float8 AS "verifiedRange",count(*) FILTER(WHERE verification='verified_dns')::float8 AS "verifiedDns",count(*) FILTER(WHERE verification='verified_edge')::float8 AS "verifiedEdge",count(*) FILTER(WHERE verification='range_mismatch')::float8 AS "rangeMismatch",
      count(*) FILTER(WHERE verification NOT IN('verified_range','verified_dns','verified_edge','range_mismatch'))::float8 AS unverified,
      count(distinct path) FILTER(WHERE method='GET' AND status>=200 AND status<300 AND EXISTS(SELECT 1 FROM liekan_catalog c WHERE c.website_id=l.website_id AND c.path=l.path))::int AS "successfulCatalogPages",
      max(created_at) AS "lastVisit",count(*) FILTER(WHERE l.reporting_classification_version IS NULL)::int AS "legacyRecords" ${reportingCrawlerBase}${crawlerIdentitySql(identityScope, 'l')} AND NOT ${unknownCrawlerSql('l')} GROUP BY 1,2 ORDER BY requests DESC`,
            ...args,
          );
          const pages = warehouseEnabled() ? await warehouseCrawlerPages(tx,websiteId,startAt,endAt,identityScope) : await tx.query<CrawlerAnalyzedPage>(
            `SELECT l.reporting_crawler_id AS "botId",path,l.bot AS name,${crawlerCountColumns},sum(bytes)::float8 AS bytes,
      count(*) FILTER(WHERE ${crawlerOwnedBlock})::int AS "ownedTerminatingBlocks",
      count(*) FILTER(WHERE ${crawlerOwnedMatch})::int AS "ownedMatches"
      ${reportingCrawlerBase}${crawlerIdentitySql(identityScope, 'l')} AND NOT ${unknownCrawlerSql('l')} GROUP BY 1,2,3 ORDER BY requests DESC,path LIMIT 1001`,
            ...args,
          );
          const duration = endAt - startAt;
          const previousRange = {
            startAt: Math.max(0, startAt - duration),
            endAt: startAt,
            timezone,
          };
          const previousBots = warehouseEnabled() ? await warehouseCrawlerBots(websiteId,previousRange.startAt,previousRange.endAt,identityScope,false) : await tx.query(
            `SELECT l.reporting_crawler_id AS "botId",l.bot AS name,${crawlerCountColumns},sum(bytes)::float8 AS bytes ${reportingCrawlerBase}${crawlerIdentitySql(identityScope, 'l')} AND NOT ${unknownCrawlerSql('l')} GROUP BY 1,2`,
            websiteId,
            new Date(previousRange.startAt),
            new Date(previousRange.endAt),
          );
          const previousQuality = await crawlerWindowQuality(
            tx,
            websiteId,
            previousRange.startAt,
            previousRange.endAt,
            timezone,
          );
          const previousReferrals = await crawlerReferralRows(
            tx,
            websiteId,
            new Date(previousRange.startAt),
            new Date(previousRange.endAt),
            timezone,
            { halfOpen: true },
          );
          const referralRows = await crawlerReferralRows(
            tx,
            websiteId,
            new Date(startAt),
            new Date(endAt),
            timezone,
            { halfOpen: true },
          );
          const population = await readTransactionBrowserPopulation(tx, websiteId, range);
          const previousPopulation = await readTransactionBrowserPopulation(
            tx,
            websiteId,
            previousRange,
          );
          const [browser] = warehouseEnabled() ? await warehouseReportQuery<{connected:number}>(websiteId,`SELECT EXISTS(SELECT 1 FROM ${factRelation('website_event')} LIMIT 1) AS connected`) : await tx.query(
            'SELECT EXISTS(SELECT 1 FROM liekan_raw_website_event WHERE website_id=$1::uuid LIMIT 1) AS connected',
            websiteId,
          );
          const [goals] = await tx.query(
            "SELECT count(*)::int AS count FROM report WHERE website_id=$1::uuid AND type='goal'",
            websiteId,
          );
          const summarizePlatforms = (
            rows: Awaited<ReturnType<typeof crawlerReferralRows>>,
            population: BrowserPopulation,
          ) =>
            getCrawlerPlatformIds().map(platformId => {
              const supported = platformHasReferrals(platformId);
              const identityReady = identityUsable(population);
              const matching = rows.filter(row => {
                const source = classifyEntrySource(row);
                return (
                  ['AI 搜索引荐', '传统搜索'].includes(source.channel) &&
                  platformForSource(source.source) === platformId
                );
              });
              const landing = new Map<
                string,
                {
                  path: string;
                  visits: number;
                  conversions: number | null;
                  goalEvents: number | null;
                }
              >();
              for (const row of matching) {
                const path = row.path || '/';
                const current = landing.get(path) || {
                  path,
                  visits: 0,
                  conversions: goals.count ? 0 : null,
                  goalEvents: goals.count ? 0 : null,
                };
                current.visits += row.visits;
                if (goals.count) {
                  current.conversions += row.conversions;
                  current.goalEvents += row.goalEvents || 0;
                }
                landing.set(path, current);
              }
              return {
                platformId,
                state: !supported
                  ? ('unsupported' as const)
                  : browser.connected
                    ? identityReady
                      ? ('available' as const)
                      : ('unknown' as const)
                    : ('missing' as const),
                visits:
                  supported && browser.connected && identityReady
                    ? matching.reduce((n, row) => n + row.visits, 0)
                    : null,
                conversions:
                  supported && browser.connected && identityReady && goals.count
                    ? matching.reduce((n, row) => n + row.conversions, 0)
                    : null,
                goalEvents:
                  supported && browser.connected && identityReady && goals.count
                    ? matching.reduce((n, row) => n + (row.goalEvents || 0), 0)
                    : null,
                landingPages: [...landing.values()]
                  .sort((a, b) => b.visits - a.visits)
                  .slice(0, 1000)
                  .map(row => ({
                    ...row,
                    visits: identityReady ? row.visits : null,
                    conversions: identityReady ? row.conversions : null,
                    goalEvents: identityReady ? row.goalEvents : null,
                  })),
                landingPagesTruncated: landing.size > 1000,
              };
            });
          const platforms = summarizePlatforms(referralRows, population);
          const [configured] = await tx.query(
            'SELECT critical_paths FROM liekan_crawler_state WHERE website_id=$1::uuid',
            websiteId,
          );
          const findings = await tx.query(
            "SELECT key,bot_id AS \"botId\",type,path_group AS \"pathGroup\",grade,confidence,state,facts,first_seen_at AS \"firstSeenAt\",last_seen_at AS \"lastSeenAt\",window_end AS \"windowEnd\",(SELECT count(*)::int FROM liekan_crawler_finding_window fw WHERE fw.website_id=liekan_crawler_finding.website_id AND fw.key=liekan_crawler_finding.key) AS \"occurrenceWindows\",(SELECT jsonb_build_object('state',CASE WHEN w.occurrence_version=liekan_crawler_finding.occurrence_version AND w.epoch=coalesce((SELECT epoch FROM liekan_log_state WHERE website_id=liekan_crawler_finding.website_id),1) AND w.classification_version IS NOT DISTINCT FROM liekan_crawler_finding.facts->'lastQuality'->>'classificationVersion' AND (CASE w.bound_grade WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 WHEN 'info' THEN 1 ELSE 0 END)>=(CASE liekan_crawler_finding.grade WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) AND (w.state<>'snoozed' OR w.snoozed_until>clock_timestamp()) THEN w.state ELSE 'pending' END,'snoozedUntil',w.snoozed_until) FROM liekan_crawler_finding_workflow w WHERE w.website_id=liekan_crawler_finding.website_id AND w.finding_key=liekan_crawler_finding.key) AS workflow FROM liekan_crawler_finding WHERE website_id=$1::uuid ORDER BY CASE grade WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,last_seen_at DESC LIMIT 200",
            websiteId,
          );
          const [analysis] = await tx.query(
            'SELECT computed_at AS "computedAt",window_end AS "windowEnd",error_code AS "errorCode" FROM liekan_crawler_analysis_state WHERE website_id=$1::uuid',
            websiteId,
          );
          const pathMappings = new Map<string, string[]>();
          for (const row of pages) {
            const human = humanPathFromEncoded(row.path);
            pathMappings.set(human, [...new Set([...(pathMappings.get(human) || []), row.path])]);
          }
          return {
            range,
            population,
            quality,
            directory: crawlerDirectoryForObserved(
              [...bots, ...previousBots, ...findings].map(row => row.botId).filter(Boolean),
            ),
            bots,
            pagesTruncated: pages.length > 1000,
            pages: pages.slice(0, 1000).map(row => ({
              ...row,
              humanPath: humanPathFromEncoded(row.path),
              mergedPaths: pathMappings.get(humanPathFromEncoded(row.path)),
            })),
            platforms,
            previous: {
              range: previousRange,
              population: previousPopulation,
              quality: previousQuality,
              bots: previousBots,
              platforms: summarizePlatforms(previousReferrals, previousPopulation),
            },
            findings,
            criticalPaths: configured?.critical_paths || [],
            analysis: analysis || null,
            generatedAt: new Date().toISOString(),
          };
        },
        { timeout: 30000, transactionTimeout: 60000, repeatableRead: true },
      ),
  );
  noteCacheResult(cached);
  if (cached.value.population) noteBrowserPopulation(websiteId, cached.value.population);
  if (cached.value.previous?.population)
    noteBrowserPopulation(websiteId, cached.value.previous.population);
  const currentAccess = await crawlerTransaction(tx => authorizeCrawler(tx, actor, websiteId));
  return {
    ...cached.value,
    permissions: { canDraft: currentAccess.canDraft, canControl: currentAccess.canControl },
  };
}
export async function saveCrawlerCriticalPaths(
  actor: CrawlerActor,
  websiteId: string,
  paths: string[],
) {
  const result = await crawlerTransaction(async tx => {
    await authorizeCrawler(tx, actor, websiteId, 'draft');
    await tx.execute(
      'INSERT INTO liekan_log_state(website_id) VALUES($1::uuid) ON CONFLICT DO NOTHING',
      websiteId,
    );
    await tx.execute(
      'INSERT INTO liekan_crawler_state(website_id,critical_paths) VALUES($1::uuid,$2::jsonb) ON CONFLICT(website_id) DO UPDATE SET critical_paths=EXCLUDED.critical_paths,updated_at=now()',
      websiteId,
      JSON.stringify(paths),
    );
    return { paths };
  });
  analyticsCache.invalidate(websiteCacheTag(websiteId));
  return result;
}
export async function changeCrawlerFinding(
  actor: CrawlerActor,
  websiteId: string,
  key: string,
  ignored: boolean,
) {
  if (!/^cr_[a-f0-9]{64}$/.test(key)) throw new LiekanError('风险标识无效', 400);
  const result = await crawlerTransaction(async tx => {
    await tx.query(
      'SELECT website_id FROM website WHERE website_id=$1::uuid FOR UPDATE',
      websiteId,
    );
    await authorizeCrawler(tx, actor, websiteId, 'draft');
    const rows = await tx.query(
      'UPDATE liekan_crawler_finding SET state=$3,updated_at=now() WHERE website_id=$1::uuid AND key=$2 RETURNING key,state',
      websiteId,
      key,
      ignored ? 'ignored' : 'active',
    );
    if (!rows.length) throw new LiekanError('风险记录不存在', 404);
    await tx.execute(
      "UPDATE liekan_crawler_finding_workflow SET state='pending',snoozed_until=NULL,workflow_revision=workflow_revision+1,updated_at=now() WHERE website_id=$1::uuid AND finding_key=$2 AND (state<>'pending' OR snoozed_until IS NOT NULL)",
      websiteId,
      key,
    );
    return rows[0];
  });
  analyticsCache.invalidate(websiteCacheTag(websiteId));
  return result;
}

export const crawlerAnalysis: typeof crawlerAnalysisSnapshot = (...args) => {
  const work = () => withPublishedRegistry(() => crawlerAnalysisSnapshot(...args));
  return warehouseEnabled() ? withinWarehouseReport(work) : work();
};
function warehouseCrawlerRead<T>(work:(tx:AiTx)=>Promise<T>,_options?:unknown) {
  return warehouseControlRead(work);
}
