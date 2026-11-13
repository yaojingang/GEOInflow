import { logCountQuery } from '../contracts/log-read';
import { requestApi } from '../http';
import {
  analysisAsyncRequested,
  privateAnalysisResponse,
  publishedLogCountResponse,
} from './analysis-query-api';
import { authenticateCrawlerMaintenance } from './crawler-maintenance';
import { LiekanError } from './errors';
import { readLogCount, readLogEntries, readLogSummary } from './log-read';
import { logReadBoundary, parseLogRead } from './log-read-boundary';
import { getQuerySnapshot } from './query-snapshot';
import { authorize, reportSnapshot } from './server';
import { ReportFragmentMiss, withReportFragments } from './report-fragments';
import { currentCacheContext } from './cache-context';
import { analyticsGate } from './analytics-budget';
import { analyticsQueryFailure } from './analytics-deadline';

export async function logReadResponse(
  request: Request,
  websiteId: string,
  part: 'entries' | 'count' | 'summary',
) {
  const started = performance.now();
  let authMs = 0;
  const response = await requestApi(request, async () => {
    const began = performance.now();
    const actor = await authenticateCrawlerMaintenance(request);
    const access = await authorize(request, websiteId);
    authMs = performance.now() - began;
    const input = Object.fromEntries(new URL(request.url).searchParams);
    const parsed = parseLogRead(input);
    if (part === 'entries') return readLogEntries(access.website, parsed, access.canManage);
    if (!logCountQuery.safeParse(input).success) throw new LiekanError('日志读取边界无效', 400);
    const target = part === 'summary' ? 'feature:log-summary' : 'feature:log-count';
    if (analysisAsyncRequested(request, target)) {
      await reportSnapshot(() => logReadBoundary(getQuerySnapshot(), access.website.id, parsed));
      if (part === 'count' && parsed.refresh !== '1') {
        const saved = await publishedLogCountResponse(request, access.website.id, actor, parsed);
        if (saved) return saved;
      }
      if (parsed.crawlerMetricsVersion === 1 && (part === 'summary' || !parsed.search)) {
        const context = currentCacheContext();
        const deadline = context.deadline;
        context.deadline = Math.min(deadline ?? Infinity, Date.now() + 750);
        try {
          const value = await analyticsGate.run(
            () =>
              withReportFragments<unknown>(
                access.website.id,
                () =>
                  part === 'summary'
                    ? readLogSummary(access.website.id, parsed)
                    : readLogCount(access.website.id, parsed),
                { logStatistics: true, readOnly: true },
              ),
            context.deadline,
          );
          // A permission change during the bounded tail read cannot expose saved private facts.
          await authorize(request, websiteId);
          await reportSnapshot(() =>
            logReadBoundary(getQuerySnapshot(), access.website.id, parsed),
          );
          return Response.json(value, {
            headers: { 'X-Liekan-Read-Path': 'published', 'Cache-Control': 'private, no-store' },
          });
        } catch (error) {
          const failure = analyticsQueryFailure(error, context.deadline, false);
          if (
            !(error instanceof ReportFragmentMiss) &&
            (failure as any)?.status !== 503 &&
            !['P2024', 'P2028'].includes((error as any)?.code)
          )
            throw error;
        } finally {
          context.deadline = deadline;
        }
      }
      return privateAnalysisResponse(request, access.website.id, actor, target, parsed);
    }
    return part === 'summary'
      ? readLogSummary(access.website.id, parsed)
      : readLogCount(access.website.id, parsed);
  });
  response.headers.append(
    'Server-Timing',
    `auth;dur=${authMs.toFixed(1)},log-${part};dur=${(performance.now() - started - authMs).toFixed(1)},request;dur=${(performance.now() - started).toFixed(1)}`,
  );
  return response;
}
