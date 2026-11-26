import type { AiTx } from './ai-db';
import type { EvidenceQuery } from '../contracts/traffic-evidence';
import type { EvidenceInputs } from '../crawlers/evidence-read';
import { evidenceMeta } from '../crawlers/evidence-read';
import { finalizeOutcomeRow, OUTCOME_MAPPING_VERSION } from '../crawlers/outcome-metrics';
import { identityUsable, type BrowserPopulation } from '../contracts/browser-population';
import { readTransactionBrowserPopulation } from './browser-population';
import { humanPathFromEncoded } from './paths';
import { normalizeCollectionHostname } from '../traffic-quality/hostname';
import { classifyEntrySource, platformForReferral } from '../contracts/sources';
import { getKnownCrawlerDirectory } from '../crawlers/directory';
import { warehouseOutcomeLogs, warehouseEvidenceSignal } from './warehouse-evidence-queries';
import { warehouseBrowserConnected } from './warehouse-presence';
import { warehouseBrowserParameters } from './warehouse-browser-queries';
import { factRelation } from '../warehouse/read';
import { websiteEventRelation, repairedQualityRelation } from '../warehouse/reporting-relations';
import { warehouseReportStream } from './warehouse-report-snapshot';
import {
  warehouseCatalogHumanPaths,
  warehouseCatalogHumanRelation,
} from './warehouse-catalog-human-paths';
import {
  WarehouseEvidenceSpool,
  type EvidenceProducer,
  type SpoolRows,
} from './warehouse-evidence-spool';
import {
  registerWarehouseEvidenceRows,
  warehouseEvidenceRows,
  warehouseEvidenceSections,
} from './warehouse-evidence-table';

// Visits, not events or UV, are the referral denominator. Preserve the earliest
// eligible entry before/inside the window and distinct matched events per visit.
export const outcomeReferralSQL = () => `WITH events AS (
  SELECT e.session_id AS session_id,e.visit_id AS visit_id,e.event_id AS event_id,e.created_at AS created_at,
    e.event_type AS event_type,e.url_path AS url_path,e.event_name AS event_name,e.referrer_domain AS referrer_domain,
    e.utm_source AS utm_source,e.utm_medium AS utm_medium,e.utm_campaign AS utm_campaign,q.hostname AS outcome_hostname
  FROM ${websiteEventRelation()} e
  INNER JOIN ${factRelation('session', { columns: ['website_id', 'session_id'] })} s
    ON s.session_id=e.session_id AND s.website_id=e.website_id
  LEFT JOIN ${repairedQualityRelation()} q ON q.event_id=e.event_id AND q.website_id=e.website_id
  WHERE e.created_at<{end:DateTime64(6,'UTC')}),
  active_visits AS(SELECT DISTINCT ev.session_id AS session_id,ev.visit_id AS visit_id FROM events ev
    WHERE created_at>={start:DateTime64(6,'UTC')} AND event_type NOT IN(2,5)),
  entries AS(SELECT ev.session_id AS session_id,ev.visit_id AS visit_id,
    argMin(tuple(url_path,referrer_domain,utm_source,utm_medium,utm_campaign,outcome_hostname),tuple(created_at,event_id)) AS entry
    FROM events ev WHERE event_type NOT IN(2,5) AND (ev.session_id,ev.visit_id) IN(SELECT session_id,visit_id FROM active_visits)
    GROUP BY ev.session_id,ev.visit_id),
  goals AS(SELECT ev.session_id AS session_id,ev.visit_id AS visit_id,uniqExactIf(event_id,arrayExists(g ->
    ((g.1='path' AND event_type=1) OR (g.1!='path' AND event_type=2)) AND
    if(startsWith(g.2,'*') OR endsWith(g.2,'*'),if(g.1='path',url_path,event_name) LIKE replaceRegexpOne(replaceRegexpOne(g.2,'^[*]','%'),'[*]$','%'),if(g.1='path',url_path,event_name)=g.2),
    arrayZip({goalTypes:Array(String)},{goalValues:Array(String)}))) AS events
    FROM events ev WHERE created_at>={start:DateTime64(6,'UTC')} GROUP BY ev.session_id,ev.visit_id)
  SELECT entry.1 AS path,entry.2 AS referrer,entry.3 AS utmSource,entry.4 AS utmMedium,entry.5 AS utmCampaign,entry.6 AS hostname,
    count() AS visits,countIf(coalesce(g.events,0)>0) AS conversions,sum(coalesce(g.events,0)) AS goalEvents
  FROM entries e LEFT JOIN goals g ON g.session_id=e.session_id AND g.visit_id=e.visit_id
  GROUP BY path,referrer,utmSource,utmMedium,utmCampaign,hostname
  ORDER BY visits DESC,path,referrer,utmSource,utmMedium,utmCampaign,hostname`;

export async function streamOutcomeReferrals(
  site: string,
  p: EvidenceQuery,
  consume: (rows: any[]) => Promise<void>,
  signal?: AbortSignal,
) {
  const params = await warehouseBrowserParameters(
    site,
    new Date(p.startAt),
    new Date(p.endAt),
    p.timezone,
  );
  return warehouseReportStream(
    site,
    outcomeReferralSQL(),
    params,
    async rows => {
      await consume(
        rows.map(row => {
          const result = { ...row };
          for (const field of ['visits', 'conversions', 'goalEvents']) {
            const value = Number(row[field]);
            if (!Number.isSafeInteger(value) || value < 0)
              throw new Error('warehouse-counter-out-of-range');
            result[field] = value;
          }
          return result;
        }),
      );
    },
    signal,
    true,
  );
}

type OutcomeContext = {
  hostname: string | null;
  goalsConfigured: boolean;
  connected: boolean;
  browserPopulation: BrowserPopulation;
};
type Contribution = Record<string, any> & {
  kind: 'catalog' | 'log' | 'browser';
  path: string;
  encoded: string;
  platformId?: string;
};
const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const add = (a: number, b: number) => {
  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum < 0) throw new Error('warehouse-counter-out-of-range');
  return sum;
};

/** CH handles event/visit aggregation. Disk merge keeps JS decodeURI, hostname
 * and live referral-rule semantics exactly, without a result-size ceiling. */
export async function buildWarehouseOutcomeRows(
  p: EvidenceQuery,
  input: EvidenceInputs,
  context: OutcomeContext,
  logs: EvidenceProducer<any>,
  referrals: EvidenceProducer<any>,
  signal?: AbortSignal,
  catalogPaths: EvidenceProducer<string> = async emit => {
    for (const row of input.catalog) await emit(row.path);
  },
) {
  const spool = await WarehouseEvidenceSpool.create(signal);
  try {
    const directory = getKnownCrawlerDirectory();
    const crawlerPlatforms = new Map(directory.map(row => [row.id, row.platformId]));
    const selectedPlatform = p.botId
      ? directory.find(row => row.id === p.botId)?.platformId
      : undefined;
    const chosenPath = p.path ? humanPathFromEncoded(p.path) : undefined;
    let sequence = 0;
    const raw = await spool.sort<Contribution>(
      async emit => {
        await catalogPaths(async path =>
          emit({ kind: 'catalog', path: humanPathFromEncoded(path), encoded: path }),
        );
        await logs(async log =>
          emit({
            ...log,
            kind: 'log',
            path: humanPathFromEncoded(log.path),
            encoded: log.path,
            platformId: crawlerPlatforms.get(log.crawler_id) ?? `custom:${log.bot}`,
            sequence: sequence++,
          }),
        );
        await referrals(async referral => {
          const source = classifyEntrySource(referral);
          if (!['AI 搜索引荐', '传统搜索'].includes(source.channel)) return;
          const product = platformForReferral(source.source.toLowerCase());
          if (
            !product ||
            (selectedPlatform && product.id !== selectedPlatform) ||
            (p.botName && !selectedPlatform) ||
            (chosenPath && referral.path !== chosenPath)
          )
            return;
          if (
            referral.hostname &&
            normalizeCollectionHostname(referral.hostname) !== context.hostname
          )
            return;
          await emit({
            kind: 'browser',
            path: referral.path,
            encoded: '',
            platformId: product.id,
            sequence: sequence++,
            visits: referral.hostname ? referral.visits : 0,
            unknownBrowserHost: referral.hostname ? 0 : referral.visits,
            conversions: referral.hostname ? referral.conversions : 0,
            goalEvents: referral.hostname ? referral.goalEvents : 0,
          });
        });
      },
      (a, b) => textOrder(a.path, b.path) || textOrder(a.encoded, b.encoded),
    );
    // Count distinct encoded forms one at a time, across catalog and every
    // selected crawler/platform. Browser paths are already decoded once.
    const mappings = await spool.write<{ path: string; ambiguous: boolean }>(async emit => {
      let path: string | undefined,
        encoded: string | undefined,
        distinct = 0;
      for await (const row of raw.iterate()) {
        if (path !== row.path) {
          if (path !== undefined) await emit({ path, ambiguous: distinct > 1 });
          path = row.path;
          encoded = undefined;
          distinct = 0;
        }
        if (row.kind !== 'browser' && row.encoded !== encoded) {
          distinct++;
          encoded = row.encoded;
        }
      }
      if (path !== undefined) await emit({ path, ambiguous: distinct > 1 });
    });
    const catalogMembership = await spool.write<{ path: string; encoded: string }>(async emit => {
      let previous: string | undefined;
      for await (const row of raw.iterate())
        if (row.kind === 'catalog' && row.encoded !== previous) {
          await emit({ path: row.path, encoded: row.encoded });
          previous = row.encoded;
        }
    });
    const mapped = await spool.sort<Contribution>(
      async emit => {
        const iterator = mappings.iterate();
        const catalogIterator = catalogMembership.iterate();
        let mapping = await iterator.next();
        let catalog = await catalogIterator.next();
        try {
          for await (const row of raw.iterate()) {
            while (!mapping.done && textOrder(mapping.value.path, row.path) < 0)
              mapping = await iterator.next();
            while (
              !catalog.done &&
              (textOrder(catalog.value.path, row.path) ||
                textOrder(catalog.value.encoded, row.encoded)) < 0
            )
              catalog = await catalogIterator.next();
            if (row.kind !== 'catalog')
              await emit({
                ...row,
                catalog:
                  !catalog.done &&
                  catalog.value.path === row.path &&
                  catalog.value.encoded === row.encoded,
                ambiguous:
                  !mapping.done && mapping.value.path === row.path && mapping.value.ambiguous,
              });
          }
        } finally {
          await iterator.return(undefined);
          await catalogIterator.return(undefined);
        }
      },
      (a, b) =>
        textOrder(a.platformId!, b.platformId!) ||
        textOrder(a.path, b.path) ||
        textOrder(a.encoded, b.encoded),
    );
    await raw.remove();
    await mappings.remove();
    await catalogMembership.remove();
    let result: SpoolRows<any>;
    let platform: any;
    const identityReady = identityUsable(context.browserPopulation);
    const totals = { requests: 0, get2xx: 0, visits: 0 as number | null };
    const unsortedReasons = await spool.write<any>(async emitReason => {
      const finishPlatform = async () => {
        if (!platform) return;
        const known = identityReady && context.connected && platform.browserHostKnown;
        await emitReason({
          sequence: platform.sequence,
          platformId: platform.platformId,
          requests: platform.requests,
          get2xx: platform.get2xx,
          catalogPaths: platform.catalogPaths,
          visits: known ? platform.visits : null,
          conversions: known && context.goalsConfigured ? platform.conversions : null,
          goalEvents: known && context.goalsConfigured ? platform.goalEvents : null,
          conversionRate:
            known && context.goalsConfigured && platform.visits
              ? platform.conversions / platform.visits
              : null,
        });
      };
      result = await spool.sort<any>(
        async emit => {
          let group: any, previousCatalog: string | undefined;
          const flush = async () => {
            if (!group) return;
            const row = finalizeOutcomeRow(group, p, input, context);
            delete row.sequence;
            if (platform?.platformId !== row.platformId) {
              await finishPlatform();
              platform = {
                platformId: row.platformId,
                requests: 0,
                get2xx: 0,
                catalogPaths: 0,
                visits: 0,
                conversions: 0,
                goalEvents: 0,
                browserHostKnown: true,
                sequence: group.sequence,
              };
            }
            for (const key of [
              'requests',
              'get2xx',
              'catalogPaths',
              'visits',
              'conversions',
              'goalEvents',
            ])
              platform[key] = add(platform[key], row[key] ?? 0);
            platform.browserHostKnown &&= row.browserHostKnown;
            platform.sequence = Math.min(platform.sequence, group.sequence);
            totals.requests = add(totals.requests, row.requests);
            totals.get2xx = add(totals.get2xx, row.get2xx);
            totals.visits =
              totals.visits === null || !row.browserHostKnown
                ? null
                : add(totals.visits, row.visits ?? 0);
            await emit(row);
          };
          for await (const item of mapped.iterate()) {
            if (!group || group.platformId !== item.platformId || group.path !== item.path) {
              await flush();
              previousCatalog = undefined;
              group = {
                platformId: item.platformId,
                path: item.path,
                requests: 0,
                get2xx: 0,
                visits: 0,
                conversions: context.goalsConfigured ? 0 : null,
                goalEvents: context.goalsConfigured ? 0 : null,
                catalogPaths: 0,
                ambiguous: item.ambiguous,
                unsampled: null,
                hostObserved: true,
                unknownBrowserHost: 0,
                configKnown: true,
                sequence: item.sequence,
              };
            }
            group.sequence = Math.min(group.sequence, item.sequence);
            if (item.kind === 'log') {
              group.unsampled = !group.requests
                ? item.unsampled
                : group.unsampled === null || item.unsampled === null
                  ? null
                  : group.unsampled && item.unsampled;
              group.requests = add(group.requests, item.requests);
              group.get2xx = add(group.get2xx, item.get2xx);
              group.hostObserved &&=
                item.hostObserved &&
                item.hosts === 1 &&
                normalizeCollectionHostname(item.host) === context.hostname;
              group.configKnown &&= item.configs === 1;
              if (item.get2xx && item.catalog && previousCatalog !== item.encoded) {
                group.catalogPaths++;
                previousCatalog = item.encoded;
              }
            } else {
              group.visits = add(group.visits, item.visits);
              group.unknownBrowserHost = add(group.unknownBrowserHost, item.unknownBrowserHost);
              if (context.goalsConfigured) {
                group.conversions = add(group.conversions, item.conversions);
                group.goalEvents = add(group.goalEvents, item.goalEvents);
              }
            }
          }
          await flush();
          await finishPlatform();
        },
        (a, b) => {
          const first =
            p.sort === 'path'
              ? a.path.localeCompare(b.path, 'en')
              : (a[p.sort] ?? 0) - (b[p.sort] ?? 0);
          return (
            first * (p.direction === 'asc' ? 1 : -1) ||
            a.platformId.localeCompare(b.platformId, 'en') ||
            a.path.localeCompare(b.path, 'en')
          );
        },
      );
    });
    await mapped.remove();
    const orderedReasons = await spool.sort<any>(
      async emit => {
        for await (const row of unsortedReasons.iterate()) await emit(row);
      },
      (a, b) => a.sequence - b.sequence,
    );
    await unsortedReasons.remove();
    const reasons = await spool.write<any>(async emit => {
      for await (const { sequence: _sequence, ...row } of orderedReasons.iterate()) await emit(row);
    });
    await orderedReasons.remove();
    const reasonTable = registerWarehouseEvidenceRows({
      count: () => reasons.count(),
      fingerprint: (signal?: AbortSignal) => reasons.fingerprint(signal),
      page: (offset: number, limit: number) => reasons.page(offset, limit),
      stream: (consume: (rows: any[]) => Promise<void>, signal?: AbortSignal) =>
        reasons.stream(consume, signal),
    });
    if (!identityReady || !context.connected) totals.visits = null;
    const table = registerWarehouseEvidenceRows({
      count: () => result.count(),
      fingerprint: (signal?: AbortSignal) => result.fingerprint(signal),
      page: (offset, limit) => result.page(offset, limit),
      stream: (consume, signal?: AbortSignal) => result.stream(consume, signal),
      dispose: () => spool.dispose(),
    });
    return { table, reasonTable, totals };
  } catch (error) {
    await spool.dispose();
    throw error;
  }
}

export async function readWarehouseOutcomes(
  tx: AiTx,
  site: string,
  p: EvidenceQuery,
  input: EvidenceInputs,
) {
  const browserPopulation = await readTransactionBrowserPopulation(tx, site, p);
  const hostname = normalizeCollectionHostname(
    p.sourceId === 'manual'
      ? input.access.domain
      : (input.sources.find(row => row.id === p.sourceId)?.domain ?? input.access.domain),
  );
  const [goals] = await tx.query(
    "SELECT EXISTS(SELECT 1 FROM report WHERE website_id=$1::uuid AND type='goal') AS configured",
    site,
  );
  const presence = await warehouseBrowserConnected(site);
  const signal = warehouseEvidenceSignal();
  const catalogParams = await warehouseCatalogHumanPaths(site);
  const result = await buildWarehouseOutcomeRows(
    p,
    input,
    {
      hostname,
      goalsConfigured: goals.configured,
      connected: presence.connected,
      browserPopulation,
    },
    emit =>
      warehouseOutcomeLogs(
        site,
        p,
        async rows => {
          for (const row of rows) await emit(row);
        },
        signal,
      ),
    emit =>
      streamOutcomeReferrals(
        site,
        p,
        async rows => {
          for (const row of rows) await emit(row);
        },
        signal,
      ),
    signal,
    emit =>
      warehouseReportStream(
        site,
        `SELECT encodedPath FROM ${warehouseCatalogHumanRelation}`,
        catalogParams,
        async batch => {
          for (const row of batch) await emit(String(row.encodedPath));
        },
        signal,
        true,
      ),
  );
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
    rows: [],
    reasons: [],
    [warehouseEvidenceSections]: { reasons: result.reasonTable },
    totals: result.totals,
    [warehouseEvidenceRows]: result.table,
  };
}
