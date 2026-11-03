import { z } from 'zod';
import type { requestAnalysisQuery } from './analysis-queries';
import { noteCacheResult } from './cache-context';
import { LiekanError } from './errors';
import { analysisQueryParameters } from './analysis-query-model';
import { processSingleton } from './process-singleton';
import {
  analysisViewerId,
  withAnalysisViewer,
  releaseAnalysisViewer,
  retainPublishedAnalysisViewer,
} from './analysis-viewers';

const handoffs = processSingleton(
  'analysis-early-handoffs',
  () => new Map<string, Promise<void>>(),
);
async function earlyHandoff(id: string) {
  let pending = handoffs.get(id);
  if (!pending && handoffs.size < 64) {
    pending = (async () => {
      const { getQueue } = await import('../log-ingestion/queue');
      const { dispatchAnalysisQuery } = await import('./analysis-queries');
      await dispatchAnalysisQuery(id, await getQueue());
    })()
      .catch(() => {})
      .finally(() => handoffs.delete(id));
    handoffs.set(id, pending);
  }
  if (!pending) return;
  let timeout: ReturnType<typeof setTimeout>;
  try {
    // Queue recovery runs independently; it cannot hold a committed HTTP handle indefinitely.
    await Promise.race([
      pending,
      new Promise<void>(resolve => {
        timeout = setTimeout(resolve, 150);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function analysisAsyncRequested(request: Request, target?: string) {
  if (
    process.env.CLICKHOUSE_URL ||
    ['3', '4'].includes(new URL(request.url).searchParams.get('eventType')) ||
    !request.headers
      .get('prefer')
      ?.split(',')
      .some(v => v.trim() === 'respond-async')
  )
    return false;
  if (target) {
    try {
      analysisQueryParameters(target, Object.fromEntries(new URL(request.url).searchParams));
    } catch {
      return false;
    }
  }
  return true;
}
export function analysisResponse(value: Awaited<ReturnType<typeof requestAnalysisQuery>>) {
  if (value.ready) {
    noteCacheResult({
      value: value.value,
      generatedAt: value.generatedAt,
      expiresAt: value.expiresAt,
      status: 'hit',
    });
    return Response.json(value.value, { headers: { 'Cache-Control': 'private, no-store' } });
  }
  const retryAfterMs = 'analysisJob' in value ? (value.analysisJob.retryAfterMs ?? 3000) : 3000;
  return Response.json(
    {
      analysisJob: (value as { analysisJob: unknown }).analysisJob,
      ...('previousResult' in value ? { previousResult: value.previousResult } : {}),
    },
    {
      status: 202,
      headers: {
        'Cache-Control': 'private, no-store',
        'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
      },
    },
  );
}
export async function asyncAnalysisResponse(request: Request, websiteId: string, target: string) {
  const { authenticateCrawlerMaintenance } = await import('./crawler-maintenance');
  const { authorize } = await import('./server');
  const { requestDashboardSnapshot, dashboardRefreshJobId } = await import('./dashboard-snapshots');
  const actor = await authenticateCrawlerMaintenance(request);
  const access = await authorize(request, websiteId);
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const { readLocaleCookie } = await import('../i18n/locale');
  const locale =
    readLocaleCookie(request.headers.get('cookie') || '') ||
    (request.headers.get('accept-language')?.startsWith('en') ? 'en-US' : 'zh-CN');
  const viewerId = analysisViewerId(request);
  const admittedAt = performance.now();
  let value = await withAnalysisViewer(viewerId, () =>
    requestDashboardSnapshot(access.website.id, actor, target, query, locale),
  );
  const admissionMs = performance.now() - admittedAt;
  const foregroundAt = performance.now();
  let readPath = value.ready ? 'published' : 'queued';
  if (viewerId && !value.ready && target === 'feature:page-report' && query.refresh !== '1') {
    const { processAnalysisQuery, readAnalysisQuery } = await import('./analysis-queries');
    const attempted = await processAnalysisQuery(value.analysisJob.id, { firstPage: true });
    if (attempted.acquired && attempted.value === undefined) {
      const result = await readAnalysisQuery(access.website.id, actor, value.analysisJob.id, true);
      if (result.ready) {
        value = result;
        readPath = 'foreground';
      }
    }
  }
  const foregroundMs = performance.now() - foregroundAt;
  const dispatchId = value.ready === false ? value.analysisJob.id : dashboardRefreshJobId(value);
  if (viewerId && value.ready && dispatchId)
    await withAnalysisViewer(viewerId, () =>
      retainPublishedAnalysisViewer(access.website.id, actor.id, dispatchId),
    ).catch(() => false);
  if (dispatchId) await earlyHandoff(dispatchId);
  const response = analysisResponse(value);
  response.headers.set('X-Liekan-Read-Path', readPath);
  response.headers.append(
    'Server-Timing',
    `analysis-admission;dur=${admissionMs.toFixed(1)},analysis-foreground;dur=${foregroundMs.toFixed(1)}`,
  );
  if ('dataThrough' in value && 'snapshotState' in value) {
    response.headers.set('X-Liekan-Data-Through', String(value.dataThrough));
    response.headers.set('X-Liekan-Snapshot-State', String(value.snapshotState));
  }
  return response;
}
export async function analysisJobResponse(
  request: Request,
  websiteId: string,
  jobId: string,
  result = false,
) {
  try {
    return await readAnalysisJobResponse(request, websiteId, jobId, result);
  } catch (error) {
    const detail = error as {
      code?: unknown;
      cause?: { code?: unknown };
      meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
    };
    if (
      ![
        detail?.code,
        detail?.cause?.code,
        detail?.meta?.code,
        detail?.meta?.driverAdapterError?.cause?.originalCode,
      ].includes('55P03')
    )
      throw error;
    // The transaction has rolled back. Keep the durable handle and retry authorization next time.
    return Response.json(
      {
        error: {
          message: '统计数据暂时不可读取，请稍后重试',
          status: 503,
          code: 'analysis-read-busy',
        },
      },
      { status: 503, headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '3' } },
    );
  }
}

async function readAnalysisJobResponse(
  request: Request,
  websiteId: string,
  jobId: string,
  result: boolean,
) {
  const { authenticateCrawlerMaintenance } = await import('./crawler-maintenance');
  const { authorize } = await import('./server');
  const { readAnalysisQuery } = await import('./analysis-queries');
  if (!z.uuid().safeParse(jobId).success) throw new LiekanError('统计任务标识无效', 400);
  const actor = await authenticateCrawlerMaintenance(request);
  const access = await authorize(request, websiteId);
  const data = await withAnalysisViewer(analysisViewerId(request), () =>
    readAnalysisQuery(access.website.id, actor, jobId, result),
  );
  if (!result) return Response.json(data, { headers: { 'Cache-Control': 'private, no-store' } });
  return analysisResponse(data);
}

export async function releaseAnalysisJobResponse(
  request: Request,
  websiteId: string,
  jobId: string,
) {
  const { authenticateCrawlerMaintenance } = await import('./crawler-maintenance');
  const { authorize } = await import('./server');
  const actor = await authenticateCrawlerMaintenance(request);
  const access = await authorize(request, websiteId);
  if (!z.uuid().safeParse(jobId).success) throw new LiekanError('统计任务标识无效', 400);
  const released = await withAnalysisViewer(analysisViewerId(request), () =>
    releaseAnalysisViewer(access.website.id, actor, jobId),
  );
  return Response.json(released, { headers: { 'Cache-Control': 'private, no-store' } });
}
