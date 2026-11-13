import { calendarDayRange } from '../contracts/calendar';
import { type LogSummary, logCountSchema, logSummarySchema } from '../contracts/log-read';
import { parseReportQuery } from '../contracts/query';
import type { DataState, LiekanReport } from '../contracts/report';
import { getPublishedCatalog } from '../crawlers/published';
import { encodeCursor } from '../cursor';
import { logSummaryView } from '../log-report-parts';
import { reportLogRow } from '../report-log-tables';
import { getSettings } from '../store';
import { warehouseEnabled } from '../warehouse/authority-routing';
import { logReadBoundary, parseLogRead } from './log-read-boundary';
import { getLogFacts, getLogToday } from './logs';
import { readLogStatistics } from './log-statistics';
import { withReportFragments } from './report-fragments';
import { currentCacheContext } from './cache-context';
import { withPublishedRegistry } from './crawler-registry-context';
import { getQuerySnapshot } from './query-snapshot';
import { reportEvidencePolicy } from './report-evidence-view';
import { query, reportSnapshot } from './server';

function logStatisticsReport<T>(websiteId: string, work: () => Promise<T>) {
  return warehouseEnabled()
    ? work()
    : withReportFragments(websiteId, work, { logStatistics: true });
}

type Website = { id: string; name: string; domain: string; siteNumber?: number | null };

export async function readLogEntries(website: Website, input: unknown, canManage: boolean) {
  const p = parseLogRead(input);
  return withPublishedRegistry(() =>
    reportSnapshot(async () => {
      const boundary = await logReadBoundary(getQuerySnapshot(), website.id, p);
      const [facts, settings] = await Promise.all([
        getLogFacts(
          website.id,
          new Date(p.startAt),
          new Date(p.endAt),
          p.timezone,
          p.page,
          p.filter,
          p.search,
          p.cursor,
          p.seek,
          ['recent', 'latest'],
          p,
          false,
          undefined,
          { cursorScope: boundary, limit: 101 },
        ),
        getSettings(website.id),
      ]);
      const recent =
        p.cursor && p.seek === 'before' ? facts.recent.slice(-100) : facts.recent.slice(0, 100);
      const state: DataState = facts.connected
        ? recent.length
          ? 'available'
          : 'empty'
        : 'not_connected';
      const now = Date.now();
      const report: LiekanReport = {
        contractVersion: 2,
        website,
        range: { startAt: p.startAt, endAt: p.endAt, timezone: p.timezone },
        states: { human: 'unavailable', logs: state, catalog: 'unavailable', goals: 'unavailable' },
        cards: [],
        charts: {},
        tables: { logBody: recent.map(reportLogRow) },
        insights: [],
        meta: {
          demo: settings.isDemo,
          canManage,
          aiCrawlerEnabled: settings.aiCrawlerEnabled,
          logsConfigured: settings.logsConfigured ?? (!settings.isDemo && !!facts.latest),
          latestImportAt: facts.latest ? new Date(facts.latest).toISOString() : null,
          ruleCount: settings.rules.length,
          catalogVersion: getPublishedCatalog()?.version,
          crawlerMetrics: {
            scope: p.crawlerIdentityScope,
            version: p.crawlerMetricsVersion ?? null,
            population: 'raw_logs',
            timeBoundary: p.crawlerMetricsVersion === 1 ? 'half_open' : 'legacy_inclusive',
          },
          logReadBoundary: boundary,
          logHasMore: p.cursor && p.seek === 'before' ? true : facts.recent.length > 100,
          logParts: { count: 'pending', summary: 'pending' },
          page: p.page,
          pageSize: 100,
          nextCursor: warehouseEnabled()
            ? facts.nextCursor
            : recent.length
              ? encodeCursor(recent.at(-1), boundary)
              : '',
          previousCursor: warehouseEnabled()
            ? facts.previousCursor
            : p.page > 1 && recent.length
              ? encodeCursor(recent[0], boundary)
              : '',
        },
      };
      return {
        ...report,
        resource: 'logs' as const,
        meta: { ...report.meta, generatedAt: now, expiresAt: now },
      };
    }, Date.now() + 10000),
  );
}

export async function readLogCount(websiteId: string, input: unknown) {
  const p = parseLogRead(input);
  return logStatisticsReport(websiteId, () =>
    reportSnapshot(async () => {
      const boundary = await logReadBoundary(getQuerySnapshot(), websiteId, p);
      if (!warehouseEnabled() && p.crawlerMetricsVersion === 1 && !p.search) {
        const counts = await readLogStatistics(websiteId, p);
        const total =
          p.filter === 'ai'
            ? counts.ai
            : p.filter === 'abnormal'
              ? counts.abnormal
              : p.filter === 'other'
                ? counts.unclassifiedRequests
                : counts.requests;
        return logCountSchema.parse({ readBoundary: boundary, total });
      }
      const facts = await getLogFacts(
        websiteId,
        new Date(p.startAt),
        new Date(p.endAt),
        p.timezone,
        1,
        p.filter,
        p.search,
        '',
        'after',
        ['count'],
        p,
        false,
        undefined,
        { cursorScope: boundary, limit: 101 },
      );
      return logCountSchema.parse({ readBoundary: boundary, total: facts.totalLogs });
    }, currentCacheContext()?.deadline),
  );
}

export async function readLogSummary(websiteId: string, input: unknown): Promise<LogSummary> {
  const p = parseLogRead(input);
  return logStatisticsReport(websiteId, () =>
    withPublishedRegistry(() =>
      reportSnapshot(async () => {
        const boundary = await logReadBoundary(getQuerySnapshot(), websiteId, p);
        const now = Date.now(),
          today = calendarDayRange(now, p.timezone).startAt;
        const [facts, settings, counters, [catalog]] = await Promise.all([
          !warehouseEnabled() && p.crawlerMetricsVersion === 1
            ? (async () => {
                const counts = await readLogStatistics(websiteId, { ...p, filter: '', search: '' });
                const latest = await getLogFacts(
                  websiteId,
                  new Date(p.startAt),
                  new Date(p.endAt),
                  p.timezone,
                  1,
                  '',
                  '',
                  '',
                  'after',
                  ['latest'],
                  p,
                  false,
                  undefined,
                  { cursorScope: boundary, limit: 101 },
                );
                return {
                  ...latest,
                  summary: {
                    ...counts,
                    pages: 0,
                    classificationVersions: counts.classifications.length,
                  },
                };
              })()
            : getLogFacts(
                websiteId,
                new Date(p.startAt),
                new Date(p.endAt),
                p.timezone,
                1,
                '',
                '',
                '',
                'after',
                ['summary', 'latest'],
                p,
                false,
                undefined,
                { cursorScope: boundary, limit: 101 },
              ),
          getSettings(websiteId),
          getLogToday(websiteId, new Date(today), new Date(Math.max(today, now))),
          query<{ count: number }>(
            'SELECT count(*)::int AS count FROM liekan_catalog WHERE website_id=$1::uuid',
            websiteId,
          ),
        ]);
        const state: DataState = facts.connected
          ? facts.summary.requests
            ? 'available'
            : 'empty'
          : 'not_connected';
        const view = logSummaryView({
          latest: facts.latest,
          catalogCount: catalog.count,
          logState: state,
          ruleCount: settings.rules.length,
          today: counters,
        });
        const conditions = parseReportQuery({ ...p, resource: 'logs' });
        return logSummarySchema.parse({
          readBoundary: boundary,
          ...(p.crawlerMetricsVersion === 1 && conditions.success
            ? {
                evidence: {
                  query: Object.fromEntries(
                    Object.entries(conditions.data).filter(([key]) => key !== 'refresh'),
                  ),
                  policySnapshot: await reportEvidencePolicy(websiteId),
                },
              }
            : {}),
          cards: view.cards,
          tables: { pipeList: view.pipeList },
          states: { logs: state, catalog: catalog.count ? 'available' : 'not_connected' },
          meta: {
            latestImportAt: facts.latest ? new Date(facts.latest).toISOString() : null,
            ruleCount: settings.rules.length,
            crawlerClassification: {
              mode:
                (facts.summary.classificationVersions ?? 0) > 1 ||
                ((facts.summary.legacyRequests ?? 0) > 0 &&
                  facts.summary.legacyRequests < facts.summary.requests)
                  ? 'mixed'
                  : (facts.summary.legacyRequests ?? 0) > 0
                    ? 'legacy'
                    : 'current',
              versions: facts.summary.classificationVersions ?? 0,
              legacyRequests: facts.summary.legacyRequests ?? 0,
              unclassifiedRequests: facts.summary.unclassifiedRequests ?? 0,
            },
          },
        }) as LogSummary;
      }, currentCacheContext()?.deadline),
    ),
  );
}
