import {
  analysisAsyncRequested,
  asyncAnalysisResponse,
} from '@/lib/liekan/upstream/analysis-query-api';
import { requestApi } from '@/lib/liekan/http';
import { readPageReport } from '@/lib/liekan/upstream/page-report';
import { authorize } from '@/lib/liekan/upstream/server';
import { noteCacheResult } from '@/lib/liekan/upstream/cache-context';
import {
  captureReportTimings,
  reportServerTiming,
  type ReportTimings,
} from '@/lib/liekan/upstream/analysis-diagnostics';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const start = performance.now();
  const timings: ReportTimings = {};
  let authMs: number | undefined;
  let reportMs: number | undefined;
  let headers: Record<string, string> = {};
  const response = await requestApi(
    request,
    async () => {
      const { websiteId } = await params;
      if (
        analysisAsyncRequested(request, 'feature:page-report') &&
        !['logs', 'human/keywords'].includes(new URL(request.url).searchParams.get('resource'))
      )
        return asyncAnalysisResponse(request, websiteId, 'feature:page-report');
      const authStart = performance.now();
      const access = await authorize(request, websiteId).finally(() => {
        authMs = performance.now() - authStart;
      });
      const query = new URL(request.url).searchParams;
      const reportStart = performance.now();
      const result = await captureReportTimings(
        () =>
          readPageReport(access.website, Object.fromEntries(query), query.get('refresh') === '1'),
        timings,
      ).finally(() => {
        reportMs = performance.now() - reportStart;
      });
      result.value.website = access.website;
      result.value.meta.canManage = access.canManage;
      noteCacheResult(result);
      headers = {
        'X-Liekan-Cache': result.status,
        'X-Liekan-Generated-At': String(result.generatedAt),
        'X-Liekan-Expires-At': String(result.expiresAt),
      };
      return result.value;
    },
    () => headers,
  );
  // These measurements belong to this HTTP request; worker records never enter response headers.
  response.headers.append(
    'Server-Timing',
    [
      `request;dur=${(performance.now() - start).toFixed(1)};desc="wall-clock"`,
      ...(authMs === undefined ? [] : [`auth;dur=${authMs.toFixed(1)};desc="wall-clock"`]),
      ...(reportMs === undefined ? [] : [`report;dur=${reportMs.toFixed(1)};desc="wall-clock"`]),
      reportServerTiming(timings),
    ]
      .filter(Boolean)
      .join(','),
  );
  return response;
}
