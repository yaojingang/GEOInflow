import { api, readBody } from '@/lib/liekan/http';
import { LiekanError } from '@/lib/liekan/upstream/errors';
import { changeAnalyticsEngine, getAnalyticsEngine } from '@/lib/liekan/upstream/analytics-engine';

export async function GET(request: Request) {
  // Control status must remain visible while fact reads are fenced for cutover.
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    return Response.json(await getAnalyticsEngine(request), { headers });
  } catch (error) {
    const status = error instanceof LiekanError ? error.status : 503;
    return Response.json(
      {
        error: {
          message: error instanceof LiekanError ? error.message : '数据查询失败，请检查服务状态',
          status,
          code: error instanceof LiekanError ? error.code : 'engine-status-unavailable',
        },
      },
      { status, headers },
    );
  }
}
export async function POST(request: Request) {
  return api(
    async () => changeAnalyticsEngine(request, await readBody(request, 4096)),
    () => ({}),
    request,
  );
}
