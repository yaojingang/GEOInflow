import { identityComplete, identityUsable } from '../contracts/browser-population';
import { pageReportParts } from '../contracts/page-report';
import { applyHumanFactsPopulation } from '../contracts/population-results';
import type { ReportQuery } from '../contracts/query';
import type { LiekanReport } from '../contracts/report';
import { classifyEntrySourceForDisplay } from '../contracts/sources';
import { addReportAiPage, compareReportAiPages, reportLogRange } from '../report-log-tables';
import type { PreparedReport } from '../report-prepared';
import { getHumanFacts, type HumanFact } from './analytics';
import { readBrowserPopulation } from './browser-population';
import { currentCacheContext } from './cache-context';
import { getLogFacts } from './logs';
import { humanPathFromEncoded } from './paths';
import { warehouseBrowserParameters, warehouseVisitsSQL } from './warehouse-browser-queries';
import { type EvidenceProducer, WarehouseEvidenceSpool } from './warehouse-evidence-spool';
import { warehouseLogQuerySpec, warehouseNumbers } from './warehouse-log-queries';
import { warehouseReportQuery, warehouseReportStream } from './warehouse-report-snapshot';

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
    currentCacheContext()?.request?.signal,
  );
}

/** Stream all human path groups for exact global cards, keeping only the current
 * table pages. Caller uses the same ordered page SQL as the legacy report. */
export async function buildWarehouseBrowserPages(
  spool: WarehouseEvidenceSpool,
  p: ReportQuery,
  produce: EvidenceProducer<any>,
  logProduce: EvidenceProducer<any>,
) {
  const tables =
    p.resource === 'overview' ? ['topBody', 'visitorTopBody'] : ['pgBody', 'visitorPgBody'];
  const rows = Object.fromEntries(tables.map(table => [table, [] as any[]]));
  let total = 0,
    entry: any,
    durationTotal = 0,
    durationSamples = 0;
  await produce(async row => {
    for (const table of tables) {
      const start = ((p.tablePages[table] ?? 1) - 1) * 20;
      if (total >= start && total < start + 20) rows[table].push(row);
    }
    total++;
    if (!entry || row.entries > entry.entries) entry = row;
    if (row.duration != null) {
      durationTotal += row.duration * row.samples;
      durationSamples += row.samples;
    }
  });
  const wanted = new Set(
    Object.values(rows)
      .flat()
      .map(row => row.path),
  );
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
  return {
    rows,
    total,
    entryPath: entry?.path ?? null,
    duration: durationSamples ? durationTotal / durationSamples : null,
    ai,
  };
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
): Promise<PreparedReport | undefined> {
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
        !['pages', 'catalog', ...(p.resource === 'human/sources' ? ['daily'] : [])].includes(field),
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
  const spool = await WarehouseEvidenceSpool.create(currentCacheContext()?.request?.signal);
  try {
    const pageData =
      p.resource !== 'human/sources'
        ? await buildWarehouseBrowserPages(
            spool,
            p,
            emit => streamBrowser(site, start, end, p.timezone, pageTail, emit),
            async emit => {
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
                currentCacheContext()?.request?.signal,
              );
            },
          )
        : undefined;
    const previousStart = new Date(Math.max(0, +start - (+end - +start + 1))),
      previousEnd = new Date(+start - 1);
    const sources =
      p.resource !== 'content'
        ? await buildWarehouseBrowserSources(
            spool,
            p,
            emit => streamBrowser(site, start, end, p.timezone, sourceTail, emit),
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
              if (table === 'visitorTopBody') return { path: row.path, pv: row.pv, uv: row.uv };
              if (table === 'topBody')
                return {
                  path: row.path,
                  humanPv: row.pv,
                  aiRequests: logs.latest ? (ai?.requests ?? 0) : null,
                  ratio:
                    logs.latest && identityComplete(human.totals.population)
                      ? ratio(ai?.requests ?? 0, row.pv)
                      : null,
                  bot: ai?.bot ?? null,
                  ...(ai?.botId !== undefined ? { botId: ai.botId } : {}),
                  evaluation: !logs.latest ? '待接入日志' : ai ? '已被抓取' : '所选范围未被抓取',
                };
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
              [table]: { page: p.tablePages[table] ?? 1, pageSize: 20, total: pageData.total },
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
