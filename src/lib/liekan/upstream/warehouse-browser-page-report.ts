import { identityComplete, identityUsable } from '../contracts/browser-population';
import { pageReportParts } from '../contracts/page-report';
import { applyHumanFactsPopulation } from '../contracts/population-results';
import { type ReportQuery, tablePageSize } from '../contracts/query';
import type { LiekanReport, Row } from '../contracts/report';
import { classifyEntrySourceForDisplay } from '../contracts/sources';
import { addReportAiPage, compareReportAiPages, reportLogRange } from '../report-log-tables';
import type { PreparedReport } from '../report-prepared';
import { timeReportQuery } from './analysis-diagnostics';
import { getHumanFacts, type HumanFact } from './analytics';
import { readBrowserPopulation } from './browser-population';
import { currentAnalyticsSignal } from './cache-context';
import { getLogFacts } from './logs';
import { humanPathFromEncoded } from './paths';
import { warehouseBrowserParameters, warehouseVisitsSQL } from './warehouse-browser-queries';
import { type EvidenceProducer, WarehouseEvidenceSpool } from './warehouse-evidence-spool';
import {
  warehouseLogDate,
  warehouseLogQuerySpec,
  warehouseLogWindowHasFacts,
  warehouseNumbers,
  warehouseOverviewLogWindow,
} from './warehouse-log-queries';
import { prepareWarehouseOverviewLogSegments } from './warehouse-overview-log-segments';
import {
  countUncrawledCatalogPaths,
  streamWarehouseCatalogPaths,
} from './warehouse-page-path-summary';
import {
  warehouseReportQuery,
  warehouseReportSignal,
  warehouseReportStream,
} from './warehouse-report-snapshot';

const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 10000) / 100 : null);
const ratio = (n: number, d: number) => (d ? Math.round((n / d) * 100) / 100 : null);
const sourceMetrics = ['sessions', 'pv', 'bounces', 'conversions', 'count'] as const;
const evidenceFields = ['utmSource', 'utmMedium', 'utmCampaign', 'referrer'] as const;
const sourceKey = (row: any) =>
  JSON.stringify([row.day, row.source, row.channel, row.sourceLabel ?? null]);
const sourceOrder = (a: any, b: any) => b.sessions - a.sessions || a.sequence - b.sequence;
const sourceTail = ` SELECT v.referrer AS referrer,v.utmSource AS utmSource,v.utmMedium AS utmMedium,v.utmCampaign AS utmCampaign,
  count() AS sessions,sum(v.pv) AS pv,avgOrNull(v.duration) AS duration,countIf(v.pv=1 AND v.custom=0) AS bounces,countIf(v.converted) AS conversions
  FROM visits v GROUP BY referrer,utmSource,utmMedium,utmCampaign ORDER BY sessions DESC,referrer,utmSource,utmMedium,utmCampaign`;
const pageTail = `,ordered AS (SELECT *,row_number() OVER(PARTITION BY visit_id,session_id ORDER BY created_at,event_id) AS ordinal,
  (leadInFrame(toNullable(toUnixTimestamp64Micro(created_at)),1,NULL) OVER(PARTITION BY visit_id,session_id ORDER BY created_at,event_id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)-toUnixTimestamp64Micro(created_at))/1000000.0 AS dwell
  FROM window_events WHERE event_type NOT IN(2,5))
  SELECT e.url_path AS path,count() AS pv,uniqExact(e.session_id) AS uv,countIf(e.ordinal=1) AS entries,avgOrNull(e.dwell) AS duration,count(e.dwell) AS samples,
  countIf(e.ordinal=1 AND e.visit_pv=1 AND e.visit_custom=0) AS bounces FROM ordered e GROUP BY path ORDER BY pv DESC,path`;
const dailySourceTail = ` SELECT formatDateTime(started,'%Y-%m-%d',{timezone:String}) AS day,referrer,utmSource,utmMedium,utmCampaign,count() AS count
  FROM visits GROUP BY day,referrer,utmSource,utmMedium,utmCampaign ORDER BY day,referrer,utmSource,utmMedium,utmCampaign`;
function numeric(row: any) {
  const result = { ...row };
  for (const key of [...sourceMetrics, 'duration', 'uv', 'entries', 'samples']) {
    if (result[key] == null) continue;
    const value = Number(result[key]);
    if (!Number.isFinite(value) || (key !== 'duration' && !Number.isSafeInteger(value)))
      throw new Error('warehouse-counter-out-of-range');
    result[key] = value;
  }
  return result;
}
async function streamBrowser(
  site: string,
  start: Date,
  end: Date,
  timezone: string,
  sql: string,
  emit: (row: any) => Promise<void>,
) {
  const params = await warehouseBrowserParameters(site, start, end, timezone);
  await warehouseReportStream(
    site,
    warehouseVisitsSQL() + sql,
    params,
    async batch => {
      for (const row of batch) await emit(numeric(row));
    },
    currentAnalyticsSignal(),
  );
}

/** Stream the ordered paths once for the global cards and the requested table rows. */
export async function buildWarehouseBrowserPages(
  spool: WarehouseEvidenceSpool,
  p: ReportQuery,
  produce: EvidenceProducer<any>,
  logProduce: EvidenceProducer<any>,
  overviewSnapshot = false,
) {
  const tables =
    p.resource === 'overview' ? ['topBody', 'visitorTopBody'] : ['pgBody', 'visitorPgBody'];
  const rows = Object.fromEntries(tables.map(table => [table, [] as any[]]));
  const ranges = tables.map(table => {
    const page = p.tablePages[table] ?? 1;
    const start = (page - 1) * tablePageSize;
    const pages = overviewSnapshot && p.resource === 'overview' && page === 1 ? 3 : 1;
    return { table, start, end: start + pages * tablePageSize };
  });
  let total = 0,
    entry: any,
    durationTotal = 0,
    durationSamples = 0;
  await produce(async row => {
    for (const { table, start, end } of ranges) {
      if (total >= start && total < end) rows[table].push(row);
    }
    total++;
    if (!entry || row.entries > entry.entries) entry = row;
    if (row.duration != null) {
      durationTotal += row.duration * row.samples;
      durationSamples += row.samples;
    }
  });
  const wanted = new Set<string>(
    Object.values(rows)
      .flat()
      .map(row => row.path),
  );
  return {
    rows,
    total,
    entryPath: entry?.path ?? null,
    duration: durationSamples ? durationTotal / durationSamples : null,
    ai: await browserPageCrawlerRows(spool, wanted, logProduce),
  };
}

async function browserPageCrawlerRows(
  spool: WarehouseEvidenceSpool,
  wanted: ReadonlySet<string>,
  logProduce: EvidenceProducer<any>,
) {
  const ai = new Map<string, any>();
  if (wanted.size) {
    // Multiple encoded log paths can decode to one human path. Reduce complete
    // encoded path groups on disk, then choose the same overall path leader.
    const sorted = await spool.sort<any>(
      async emit => {
        await logProduce(async row => {
          if (wanted.has(humanPathFromEncoded(row.path))) await emit(row);
        });
      },
      (a, b) => lexical(a.path, b.path),
    );
    let group: any;
    const flush = () => {
      if (!group) return;
      const path = humanPathFromEncoded(group.path),
        old = ai.get(path);
      if (!old) ai.set(path, { ...group, requests: group.requests, winner: group });
      else {
        old.requests += group.requests;
        if (compareReportAiPages(group, old.winner) < 0) {
          old.bot = group.bot;
          old.botId = group.botId;
          old.winner = group;
        }
      }
    };
    for await (const row of sorted.iterate()) {
      if (group?.path !== row.path) {
        flush();
        group = undefined;
      }
      group = addReportAiPage(group, row);
    }
    flush();
    await sorted.remove();
  }
  return ai;
}

function overviewRankingRow(
  table: 'topBody' | 'visitorTopBody',
  row: { path: string; pv: number; uv: number },
  ai: { requests: number; bot?: string | null; botId?: string | null } | undefined,
  hasLogs: boolean,
  population: LiekanReport['meta']['population'],
): Row {
  if (table === 'visitorTopBody')
    return {
      path: row.path,
      pv: row.pv,
      uv: !population || identityUsable(population) ? row.uv : null,
    };
  return {
    path: row.path,
    humanPv: row.pv,
    aiRequests: hasLogs ? (ai?.requests ?? 0) : null,
    ratio: hasLogs && identityComplete(population) ? ratio(ai?.requests ?? 0, row.pv) : null,
    bot: ai?.bot ?? null,
    ...(ai?.botId !== undefined ? { botId: ai.botId } : {}),
    evaluation: !hasLogs ? '待接入日志' : ai ? '已被抓取' : '所选范围未被抓取',
  };
}

/** Read only the requested ranking slice under the overview's pinned report context. */
export async function readWarehouseOverviewRankingPage(
  site: string,
  p: ReportQuery,
  snapshot: {
    tables: LiekanReport['tables'];
    meta: Pick<LiekanReport['meta'], 'population'>;
  },
  table: 'topBody' | 'visitorTopBody',
  page: number,
) {
  const { start, end, halfOpen } = reportLogRange(p);
  const params = await warehouseBrowserParameters(site, start, end, p.timezone);
  const rows = (
    await warehouseReportQuery(
      site,
      `${warehouseVisitsSQL()}
       SELECT e.url_path AS path,count() AS pv,uniqExact(e.session_id) AS uv
       FROM window_events e WHERE e.event_type NOT IN(2,5) GROUP BY path
       ORDER BY pv DESC,path LIMIT ${tablePageSize} OFFSET {overviewOffset:UInt64}`,
      { ...params, overviewOffset: String((page - 1) * tablePageSize) },
    )
  ).map(numeric);
  const population = snapshot.meta.population;
  if (!rows.length || table === 'visitorTopBody')
    return rows.map(row => overviewRankingRow(table, row, undefined, false, population));

  const hasLogs = snapshot.tables.topBody?.[0]?.aiRequests != null;
  if (!(await warehouseLogWindowHasFacts(site, start, end, halfOpen)))
    return rows.map(row => overviewRankingRow(table, row, undefined, hasLogs, population));
  const paths = new Set<string>(rows.map(row => row.path));
  const spec = await warehouseLogQuerySpec(
    start,
    end,
    p.timezone,
    p,
    p.filter,
    p.search,
    false,
    site,
  );
  const spool = await WarehouseEvidenceSpool.create(warehouseReportSignal());
  try {
    const ai = await browserPageCrawlerRows(spool, paths, async emit => {
      // Encoded aliases are verified by the same JS decoder used by the first page.
      await warehouseReportStream(
        site,
        `SELECT * FROM (${spec.statements.pages})
         WHERE path IN {overviewPaths:Array(String)} OR position(path,'%')>0`,
        { ...spec.params, overviewPaths: [...paths] },
        async batch => {
          for (const row of warehouseNumbers(batch)) await emit(row);
        },
        currentAnalyticsSignal(),
      );
    });
    return rows.map(row => overviewRankingRow(table, row, ai.get(row.path), hasLogs, population));
  } finally {
    await spool.dispose();
  }
}

/** Complete source grouping is disk-based. Only requested source rows retain
 * their legacy joined evidence strings; scalar/channel/chart output stays exact. */
export async function buildWarehouseBrowserSources(
  spool: WarehouseEvidenceSpool,
  p: ReportQuery,
  produce: EvidenceProducer<any>,
  previous: EvidenceProducer<any>,
  daily: EvidenceProducer<any>,
) {
  let sequence = 0;
  const raw = await spool.sort<any>(
    async emit => {
      await produce(async row => {
        const attribution = classifyEntrySourceForDisplay(row);
        await emit({ ...row, ...attribution, key: sourceKey(attribution), sequence: sequence++ });
      });
    },
    (a, b) => lexical(a.key, b.key),
  );
  const metrics = await spool.sort<any>(async emit => {
    let group: any;
    const flush = async () => {
      if (group)
        await emit({ ...group, duration: group.sessions ? group.duration / group.sessions : 0 });
    };
    for await (const row of raw.iterate()) {
      if (group?.key !== row.key) {
        await flush();
        group = {
          key: row.key,
          source: row.source,
          channel: row.channel,
          ...(row.sourceLabel ? { sourceLabel: row.sourceLabel } : {}),
          sequence: row.sequence,
          sessions: 0,
          pv: 0,
          bounces: 0,
          conversions: 0,
          count: 0,
          duration: 0,
        };
      }
      group.duration += (row.duration ?? 0) * (row.sessions ?? 0);
      for (const metric of sourceMetrics) group[metric] += row[metric] ?? 0;
    }
    await flush();
  }, sourceOrder);
  const selected: any[] = [],
    channels = new Map<string, { name: string; count: number }>(),
    aiSources: any[] = [];
  let total = 0;
  const offset = ((p.tablePages.srcBody ?? 1) - 1) * 20;
  for await (const row of metrics.iterate()) {
    if (p.resource === 'human/sources' && total >= offset && total < offset + 20)
      selected.push(row);
    total++;
    const channel = channels.get(row.channel) ?? { name: row.channel, count: 0 };
    channel.count += row.sessions;
    channels.set(row.channel, channel);
    if (p.resource === 'human/sources' && row.channel === 'AI 搜索引荐')
      aiSources.push({ source: row.source, sessions: row.sessions, conversions: row.conversions });
  }
  await metrics.remove();
  const byKey = new Map(selected.map(row => [row.key, row]));
  let evidenceKey: string | undefined;
  let evidence = new Map<string, Set<string>>();
  const flushEvidence = () => {
    const selected = byKey.get(evidenceKey);
    if (selected)
      for (const field of evidenceFields)
        selected[field] = [...(evidence.get(field) ?? [])].sort().join(' | ') || null;
    evidence = new Map();
  };
  if (byKey.size)
    for await (const row of raw.iterate()) {
      if (row.key !== evidenceKey) {
        flushEvidence();
        evidenceKey = row.key;
      }
      if (!byKey.has(row.key)) continue;
      for (const field of evidenceFields)
        if (row[field]) {
          if (!evidence.has(field)) evidence.set(field, new Set());
          evidence.get(field).add(row[field]);
        }
    }
  flushEvidence();
  await raw.remove();
  const previousRows = new Map<string, any>();
  if (byKey.size)
    await previous(async row => {
      const attribution = classifyEntrySourceForDisplay(row),
        key = sourceKey(attribution);
      if (!byKey.has(key)) return;
      const group = previousRows.get(key) ?? { ...attribution, sessions: 0, conversions: 0 };
      group.sessions += row.sessions ?? 0;
      group.conversions += row.conversions ?? 0;
      previousRows.set(key, group);
    });
  const days = new Map<string, any>();
  await daily(async row => {
    const { channel } = classifyEntrySourceForDisplay(row),
      key = JSON.stringify([row.day, channel]);
    const day = days.get(key) ?? { day: row.day, channel, count: 0 };
    day.count += row.count;
    days.set(key, day);
  });
  return {
    rows: selected.map(({ key, sequence, ...row }) => row),
    previous: [...previousRows.values()],
    total,
    channels: [...channels.values()],
    aiSources,
    daily: [...days.values()],
  };
}

export async function prepareWarehouseBrowserPageReport(
  site: string,
  p: ReportQuery,
  range = reportLogRange(p),
  catalogCount = 0,
  overviewSnapshot = false,
): Promise<
  (PreparedReport & { catalogCoverage?: { catalogCount: number; blindCount: number } }) | undefined
> {
  if (!['overview', 'content', 'human/sources'].includes(p.resource)) return;
  const parts = pageReportParts[p.resource],
    { start, end } = range;
  const skipped = new Set(['pages', 'sources', 'previousSources', 'dailySources']);
  const human = await getHumanFacts(
    site,
    start,
    end,
    p.timezone,
    parts.human.filter(field => !skipped.has(field)) as readonly HumanFact[],
  );
  const population = human.totals.population;
  // The observed population includes every event eligible for the qualified
  // visit streams. Only a proved empty, identical window can skip those reads.
  const emptyBrowserWindow =
    p.resource === 'overview' &&
    population?.resourceId === site &&
    population.identity.eligibleEvents === 0 &&
    population.range.startAt === +start &&
    population.range.endAt === +end &&
    population.range.timezone === p.timezone &&
    !population.range.endExclusive;
  const streamCurrentBrowser = (sql: string, emit: (row: any) => Promise<void>) =>
    emptyBrowserWindow ? Promise.resolve() : streamBrowser(site, start, end, p.timezone, sql, emit);
  const logs = await getLogFacts(
    site,
    start,
    end,
    p.timezone,
    p.page,
    p.filter,
    p.search,
    p.cursor,
    p.seek,
    parts.logs.filter(
      field =>
        ![
          'pages',
          'catalog',
          ...(p.resource === 'overview' ? ['summary', 'bots'] : []),
          ...(p.resource === 'human/sources' ? ['daily'] : []),
        ].includes(field),
    ),
    p,
  );
  if (p.resource === 'human/sources') {
    const spec = await warehouseLogQuerySpec(
      start,
      end,
      p.timezone,
      p,
      p.filter,
      p.search,
      false,
      site,
    );
    // This page only uses log days to complete the human daily chart axis.
    // Preserve the original population while keeping one row per calendar day.
    logs.daily = await warehouseReportQuery(
      site,
      `SELECT DISTINCT day FROM (${spec.statements.daily}) ORDER BY day`,
      spec.params,
    );
  }
  const spool = await WarehouseEvidenceSpool.create(warehouseReportSignal());
  try {
    const overviewPages =
      p.resource === 'overview'
        ? await timeReportQuery('overview-log-aggregate', () =>
            spool.write<any>(async emit => {
              const window = await warehouseOverviewLogWindow(site, start, end, range.halfOpen);
              if (!window.hasFacts) {
                logs.summary = {
                  requests: 0,
                  ai: 0,
                  pages: 0,
                  abnormal: 0,
                  classificationVersions: 0,
                  legacyRequests: 0,
                  unclassifiedRequests: 0,
                };
                return;
              }
              const segments = await prepareWarehouseOverviewLogSegments(site, start, end, p);
              const spec =
                segments ??
                (await warehouseLogQuerySpec(
                  start,
                  end,
                  p.timezone,
                  p,
                  p.filter,
                  p.search,
                  false,
                  site,
                  true,
                  window.restrictEvidenceToWindow,
                ).then(({ overview, params }) => ({ sql: overview, params })));
              let summarySeen = false;
              await warehouseReportStream<{ section: string; row: string }>(
                site,
                spec.sql,
                spec.params,
                async batch => {
                  for (const item of batch) {
                    const row = warehouseNumbers(JSON.parse(item.row));
                    if (item.section === 'summary') {
                      if (summarySeen) throw new Error('warehouse-overview-duplicate-summary');
                      summarySeen = true;
                      logs.summary = row;
                    } else if (item.section === 'bots')
                      logs.bots.push({ ...row, lastVisit: warehouseLogDate(row.lastVisit) });
                    else if (item.section === 'pages') await emit(row);
                    else throw new Error('warehouse-overview-section-invalid');
                  }
                },
                currentAnalyticsSignal(),
              );
              if (!summarySeen) throw new Error('warehouse-overview-summary-missing');
            }),
          )
        : undefined;
    const pageData =
      p.resource !== 'human/sources'
        ? await timeReportQuery('overview-page-ranking', () =>
            buildWarehouseBrowserPages(
              spool,
              p,
              emit =>
                timeReportQuery('overview-browser-paths', () =>
                  streamCurrentBrowser(pageTail, emit),
                ),
              async emit => {
                if (overviewPages) {
                  for await (const row of overviewPages.iterate()) await emit(row);
                  return;
                }
                const spec = await warehouseLogQuerySpec(
                  start,
                  end,
                  p.timezone,
                  p,
                  p.filter,
                  p.search,
                  false,
                  site,
                );
                await warehouseReportStream(
                  site,
                  spec.statements.pages,
                  spec.params,
                  async batch => {
                    for (const row of warehouseNumbers(batch)) await emit(row);
                  },
                  currentAnalyticsSignal(),
                );
              },
              overviewSnapshot,
            ),
          )
        : undefined;
    const catalogCoverage =
      overviewPages && catalogCount && logs.latest && overviewPages.total
        ? await timeReportQuery('overview-catalog-coverage', () =>
            countUncrawledCatalogPaths(spool, overviewPages, emit =>
              streamWarehouseCatalogPaths(site, emit),
            ),
          )
        : undefined;
    await overviewPages?.remove();
    const previousStart = new Date(Math.max(0, +start - (+end - +start + 1))),
      previousEnd = new Date(+start - 1);
    const sources =
      p.resource !== 'content'
        ? await buildWarehouseBrowserSources(
            spool,
            p,
            emit => streamCurrentBrowser(sourceTail, emit),
            emit =>
              p.resource === 'human/sources'
                ? streamBrowser(site, previousStart, previousEnd, p.timezone, sourceTail, emit)
                : Promise.resolve(),
            emit =>
              p.resource === 'human/sources'
                ? streamBrowser(site, start, end, p.timezone, dailySourceTail, emit)
                : Promise.resolve(),
          )
        : undefined;
    const previousAvailable = sources?.previous.length
      ? identityUsable(await readBrowserPopulation(site, previousStart, previousEnd, p.timezone))
      : false;
    if (sources) {
      human.sources = sources.rows;
      human.previousSources = sources.previous.map(row =>
        previousAvailable ? row : { ...row, sessions: null, conversions: null },
      );
      human.dailySources = sources.daily;
    }
    if (pageData) human.pages = Object.values(pageData.rows)[0];
    const masked = applyHumanFactsPopulation(human, human.totals.population);
    return {
      range,
      human: masked,
      logs,
      catalogCoverage,
      dispose: () => spool.dispose(),
      decorate(report: LiekanReport) {
        const setCard = (key: string, value: number | string | null) => {
          const card = report.cards.find(card => card.key === key);
          if (card) card.value = value;
        };
        if (sources) {
          const channels = [...sources.channels].sort(
            identityUsable(human.totals.population) ? (a, b) => b.count - a.count : () => 0,
          );
          if (report.charts.d3) {
            report.charts.d3.labels = channels.map(row => row.name);
            report.charts.d3.series[0].values = channels.map(row => row.count);
          }
          for (const name of ['直接访问', '传统搜索', 'AI 搜索引荐'])
            setCard(
              name,
              pct(channels.find(row => row.name === name)?.count ?? 0, human.totals.visits),
            );
          const aiSessions = sources.aiSources.reduce((n, row) => n + row.sessions, 0);
          setCard(
            'AI 引荐转化率',
            human.goals.length
              ? pct(
                  sources.aiSources.reduce((n, row) => n + row.conversions, 0),
                  aiSessions,
                )
              : null,
          );
          const aiCard = report.cards.find(card => card.key === 'AI 引荐转化率');
          if (aiCard)
            aiCard.state = human.goals.length
              ? aiSessions
                ? 'available'
                : 'empty'
              : 'not_connected';
          if (report.charts.s2) {
            report.charts.s2.labels = sources.aiSources.map(row => row.source);
            report.charts.s2.series[0].values = sources.aiSources.map(row => row.sessions);
          }
          if (report.tables.srcBody)
            report.meta.tablePages = {
              ...report.meta.tablePages,
              srcBody: { page: p.tablePages.srcBody ?? 1, pageSize: 20, total: sources.total },
            };
        }
        if (pageData) {
          setCard('有流量页面', pageData.total);
          setCard('入口页 TOP1', pageData.entryPath);
          setCard(
            '内容页平均停留',
            identityUsable(human.totals.population) ? pageData.duration : null,
          );
          for (const [table, rows] of Object.entries(pageData.rows)) {
            if (!report.tables[table]) continue;
            report.tables[table] = rows.map(row => {
              const ai = pageData.ai.get(row.path);
              if (table === 'topBody' || table === 'visitorTopBody')
                return overviewRankingRow(table, row, ai, !!logs.latest, human.totals.population);
              return {
                path: row.path,
                pv: row.pv,
                uv: row.uv,
                entries: row.entries,
                duration: row.duration,
                bounceRate: row.entries ? pct(row.bounces, row.entries) : null,
                ...(table === 'pgBody'
                  ? { aiRequests: logs.latest ? (ai?.requests ?? 0) : null }
                  : {}),
              };
            });
            report.meta.tablePages = {
              ...report.meta.tablePages,
              [table]: {
                page: p.tablePages[table] ?? 1,
                pageSize: tablePageSize,
                total: pageData.total,
              },
            };
          }
        }
      },
    };
  } catch (error) {
    await spool.dispose();
    throw error;
  }
}
