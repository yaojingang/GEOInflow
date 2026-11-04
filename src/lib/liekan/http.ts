import { warehouseTransient } from './warehouse/control-db';
import { withPublishedRegistry } from './upstream/crawler-registry-context';
import { getPublishedCatalog } from './crawlers/published';
import { z } from 'zod';
import { LiekanError } from './upstream/server';
import { withQueryCacheHeaders } from './upstream/cache-context';
import { AnalyticsRestart, AnalyticsUnavailable } from './upstream/analytics-budget';
export async function readBody(request: Request, maxBytes = 11 * 1024 * 1024) {
  const reader = request.body?.getReader();
  if (!reader) throw new LiekanError('请求内容为空');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new LiekanError(
        maxBytes === 11 * 1024 * 1024 ? '文件上限 10 MiB' : '请求内容超出上限',
        413,
      );
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new LiekanError('JSON 无效');
  }
}
export async function api(
  work: () => Promise<unknown>,
  headers: () => Record<string, string> = () => ({}),
  request?: Request,
) {
  return withQueryCacheHeaders(async () => {
    try {
      const requested = request?.headers.get('x-liekan-catalog-version');
      if (requested && !z.uuid().safeParse(requested).success)
        throw new LiekanError('目录版本无效', 400);
      const pinned =
        request &&
        (request.method === 'GET' || /\/(?:exports|export)$/.test(new URL(request.url).pathname))
          ? requested || undefined
          : undefined;
      return await withPublishedRegistry(async () => {
        const value = await work();
        if (value instanceof Response) {
          value.headers.set('Cache-Control', 'private, no-store');
          value.headers.set('X-Liekan-Catalog-Version', getPublishedCatalog()?.version || '');
          for (const [name, content] of Object.entries(headers())) value.headers.set(name, content);
          return value;
        }
        return Response.json(value, {
          headers: {
            'Cache-Control': 'private, no-store',
            'X-Liekan-Catalog-Version': getPublishedCatalog()?.version || '',
            ...headers(),
          },
        });
      }, pinned);
    } catch (error) {
      if (error instanceof AnalyticsRestart || warehouseTransient(error)) throw error;
      const status = error instanceof LiekanError ? error.status : 500;
      return Response.json(
        {
          error: {
            message: error instanceof LiekanError ? error.message : '数据查询失败，请检查服务状态',
            status,
            code: error instanceof LiekanError ? error.code : 'liekan-error',
          },
        },
        {
          status,
          headers: {
            'Cache-Control': 'private, no-store',
            ...([429, 503].includes(status)
              ? {
                  'Retry-After': String(
                    error instanceof AnalyticsUnavailable ? error.retryAfter : 60,
                  ),
                }
              : {}),
          },
        },
      );
    }
  });
}

export function requestApi(
  request: Request,
  work: () => Promise<unknown>,
  headers?: () => Record<string, string>,
) {
  return api(work, headers, request);
}
