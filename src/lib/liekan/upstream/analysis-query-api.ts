import { warehouseEnabled,warehouseTransitionEnabled } from '@/lib/liekan/warehouse/authority-routing';
import { z } from 'zod';
import type { requestAnalysisQuery } from './analysis-queries';
import { noteCacheResult } from './cache-context';
import { LiekanError } from './errors';
import { analysisQueryParameters } from './analysis-query-model';
import { processSingleton } from './process-singleton';

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
    warehouseEnabled() || warehouseTransitionEnabled() ||
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
  const { requestDashboardSnapshot } = await import('./dashboard-snapshots');
  const actor = await authenticateCrawlerMaintenance(request);
  const access = await authorize(request, websiteId);
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const { readLocaleCookie } = await import('../i18n/locale');
  const locale =
    readLocaleCookie(request.headers.get('cookie') || '') ||
    (request.headers.get('accept-language')?.startsWith('en') ? 'en-US' : 'zh-CN');
  const value = await requestDashboardSnapshot(access.website.id, actor, target, query, locale);
  if (value.ready === false) {
    await earlyHandoff(value.analysisJob.id);
  }
  const response = analysisResponse(value);
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
  const { authenticateCrawlerMaintenance } = await import('./crawler-maintenance');
  const { authorize } = await import('./server');
  const { requestAnalysisQuery, readAnalysisQuery } = await import('./analysis-queries');
  if (!z.uuid().safeParse(jobId).success) throw new LiekanError('统计任务标识无效', 400);
  const actor = await authenticateCrawlerMaintenance(request);
  const access = await authorize(request, websiteId);
  if (warehouseEnabled())
    throw new LiekanError('统计服务已升级，请刷新页面重新查询',410,'analysis-query-upgraded');
  const data = await readAnalysisQuery(access.website.id, actor, jobId, result);
  if (!result) return Response.json(data, { headers: { 'Cache-Control': 'private, no-store' } });
  return analysisResponse(data);
}
