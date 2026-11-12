import { logCountQuery } from '../contracts/log-read';
import { requestApi } from '../http';
import { analysisAsyncRequested, privateAnalysisResponse } from './analysis-query-api';
import { authenticateCrawlerMaintenance } from './crawler-maintenance';
import { LiekanError } from './errors';
import { readLogCount, readLogEntries, readLogSummary } from './log-read';
import { logReadBoundary, parseLogRead } from './log-read-boundary';
import { getQuerySnapshot } from './query-snapshot';
import { authorize, reportSnapshot } from './server';

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
    if (part === 'summary') return readLogSummary(access.website.id, parsed);
    if (analysisAsyncRequested(request, 'feature:log-count')) {
      await reportSnapshot(() => logReadBoundary(getQuerySnapshot(), access.website.id, parsed));
      return privateAnalysisResponse(
        request,
        access.website.id,
        actor,
        'feature:log-count',
        parsed,
      );
    }
    return readLogCount(access.website.id, parsed);
  });
  response.headers.append(
    'Server-Timing',
    `auth;dur=${authMs.toFixed(1)},log-${part};dur=${(performance.now() - started - authMs).toFixed(1)},request;dur=${(performance.now() - started).toFixed(1)}`,
  );
  return response;
}
