import { warehouseEnabled } from '../warehouse/authority-routing';
import { readWarehouseOutcomes } from '../upstream/warehouse-outcomes';
import { finalizeOutcomeRow, OUTCOME_MAPPING_VERSION } from './outcome-metrics';
import { readTransactionBrowserPopulation } from '../upstream/browser-population';
import { identityUsable } from '../contracts/browser-population';
import { humanPathFromEncoded } from '../upstream/paths';
import type { AiTx } from '../upstream/ai-db';
import { crawlerReferralRows } from '../upstream/analytics';
import { classifyEntrySource, platformForReferral } from '../contracts/sources';
import type { EvidenceQuery } from '../contracts/traffic-evidence';
import { getKnownCrawlerDirectory } from './directory';
import {
  evidenceScope,
  evidenceMeta,
  pathMappings,
  enforceEvidenceBudget,
  type EvidenceInputs,
} from './evidence-read';
import { normalizeCollectionHostname } from '../upstream/collection-quality';
import { eventSamplingRateSql } from '../log-ingestion/measurement';

export { OUTCOME_MAPPING_VERSION } from './outcome-metrics';
export async function readOutcomes(
  tx: AiTx,
  websiteId: string,
  p: EvidenceQuery,
  input: EvidenceInputs,
) {
  if (warehouseEnabled()) return readWarehouseOutcomes(tx, websiteId, p, input);
  const browserPopulation = await readTransactionBrowserPopulation(tx, websiteId, p);
  const identityReady = identityUsable(browserPopulation);
  const scope = evidenceScope(websiteId, p);
  const logs = await tx.query(
    `SELECT e.crawler_id,l.bot,l.path,count(*)::float8 AS requests,
    count(*) FILTER(WHERE method='GET' AND status BETWEEN 200 AND 299)::float8 AS "get2xx",
    CASE WHEN count(${eventSamplingRateSql})=count(*)
      THEN bool_and((${eventSamplingRateSql})=1) ELSE NULL END AS unsampled,
    bool_and(coalesce(e.measurement->>'hostBasis'='request_host',false)) AS "hostObserved",
    min(e.measurement->>'host') AS host,count(distinct e.measurement->>'host')::int AS hosts,
    count(distinct e.measurement->>'sourceConfigVersion')::int AS configs
    ${scope.sql} GROUP BY 1,2,3 ORDER BY 1,2,3 LIMIT 100001`,
    ...scope.args,
  );
  const referrals = await crawlerReferralRows(
    tx,
    websiteId,
    new Date(p.startAt),
    new Date(p.endAt),
    p.timezone,
    { halfOpen: true, hostEvidence: true },
  );
  enforceEvidenceBudget(logs, logs.length);
  enforceEvidenceBudget(referrals, referrals.length);
  const hostname = normalizeCollectionHostname(
    p.sourceId === 'manual'
      ? input.access.domain
      : (input.sources.find(row => row.id === p.sourceId)?.domain ?? input.access.domain),
  );
  const selectedPlatform = p.botId
    ? getKnownCrawlerDirectory().find(row => row.id === p.botId)?.platformId
    : undefined;
  const mappings = pathMappings([
    ...new Set([...input.catalog.map(row => row.path), ...logs.map(row => row.path)]),
  ]);
  const mappingByEncoded = new Map(
    mappings.flatMap(row => row.encodedPaths.map(path => [path, row] as const)),
  );
  const mappingByHuman = new Map(mappings.map(row => [row.humanPath, row]));
  const chosenPath = p.path ? humanPathFromEncoded(p.path) : undefined;
  const [goals] = await tx.query(
    "SELECT EXISTS(SELECT 1 FROM report WHERE website_id=$1::uuid AND type='goal') AS configured",
    websiteId,
  );
  const [presence] = await tx.query(
    'SELECT EXISTS(SELECT 1 FROM liekan_raw_website_event WHERE website_id=$1::uuid LIMIT 1) AS connected',
    websiteId,
  );
  const grouped = new Map<string, any>();
  const get = (platformId: string, path: string) => {
    const key = JSON.stringify([platformId, path]);
    if (!grouped.has(key))
      grouped.set(key, {
        platformId,
        path,
        requests: 0,
        get2xx: 0,
        visits: 0,
        conversions: goals.configured ? 0 : null,
        goalEvents: goals.configured ? 0 : null,
        catalogPaths: new Set<string>(),
        ambiguous: !!mappingByHuman.get(path)?.ambiguous,
        unsampled: null,
        hostObserved: true,
        unknownBrowserHost: 0,
        configKnown: true,
      });
    return grouped.get(key);
  };
  const catalogPaths = new Set(input.catalog.map(row => row.path));
  const crawlerPlatforms = new Map(getKnownCrawlerDirectory().map(row => [row.id, row.platformId]));
  for (const log of logs) {
    const platform = crawlerPlatforms.get(log.crawler_id) ?? `custom:${log.bot}`;
    const mapping = mappingByEncoded.get(log.path)!;
    const row = get(platform, mapping.humanPath);
    row.unsampled = !row.requests
      ? log.unsampled
      : row.unsampled === null || log.unsampled === null
        ? null
        : row.unsampled && log.unsampled;
    row.requests += log.requests;
    row.get2xx += log.get2xx;
    row.hostObserved &&=
      log.hostObserved && log.hosts === 1 && normalizeCollectionHostname(log.host) === hostname;
    row.configKnown &&= log.configs === 1;
    if (log.get2xx && catalogPaths.has(log.path)) row.catalogPaths.add(log.path);
  }
  for (const referral of referrals) {
    const source = classifyEntrySource(referral);
    if (!['AI 搜索引荐', '传统搜索'].includes(source.channel)) continue;
    const sourceHost = source.source.toLowerCase();
    const product = platformForReferral(sourceHost);
    if (
      !product ||
      (selectedPlatform && product.id !== selectedPlatform) ||
      (p.botName && !selectedPlatform) ||
      (chosenPath && referral.path !== chosenPath)
    )
      continue;
    if (referral.hostname && normalizeCollectionHostname(referral.hostname) !== hostname) continue;
    const row = get(product.id, referral.path);
    if (!referral.hostname) {
      row.unknownBrowserHost += referral.visits;
      continue;
    }
    row.visits += referral.visits;
    if (goals.configured) {
      row.conversions += referral.conversions;
      row.goalEvents += referral.goalEvents;
    }
  }
  const rows = [...grouped.values()].map(row => {
    return finalizeOutcomeRow(row, p, input, {
      goalsConfigured: goals.configured,
      connected: presence.connected,
      browserPopulation,
    });
  });
  const platforms = [...new Set(rows.map(row => row.platformId))].map(platformId => {
    const items = rows.filter(row => row.platformId === platformId);
    const sum = (key: string) => items.reduce((n, row) => n + (row[key] ?? 0), 0);
    const browserKnown = presence.connected && items.every(row => row.browserHostKnown);
    const visits = identityReady && browserKnown ? sum('visits') : null,
      conversions = identityReady && browserKnown && goals.configured ? sum('conversions') : null;
    return {
      platformId,
      requests: sum('requests'),
      get2xx: sum('get2xx'),
      catalogPaths: sum('catalogPaths'),
      visits,
      conversions,
      goalEvents: identityReady && browserKnown && goals.configured ? sum('goalEvents') : null,
      conversionRate: visits && goals.configured ? conversions / visits : null,
    };
  });
  return {
    meta: {
      ...evidenceMeta(p, input),
      hostname,
      browserPopulation,
      mappingVersion: OUTCOME_MAPPING_VERSION,
      goalsConfigured: goals.configured,
      browserScope: 'platform_referrals',
      logScope: p.botId || p.botName || 'platform',
    },
    rows,
    reasons: platforms,
    totals: {
      requests: rows.reduce((n, row) => n + row.requests, 0),
      get2xx: rows.reduce((n, row) => n + row.get2xx, 0),
      visits:
        identityReady && presence.connected && rows.every(row => row.browserHostKnown)
          ? rows.reduce((n, row) => n + (row.visits ?? 0), 0)
          : null,
    },
  };
}
