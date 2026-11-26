import { LiekanError } from '@/lib/liekan/upstream/errors';
import { requestApi } from '@/lib/liekan/http';
import { authorize } from '@/lib/liekan/upstream/server';
import { downloadWarehouseExport } from '@/lib/liekan/upstream/warehouse-export-artifact';
import { authenticateWarehouseExport } from '@/lib/liekan/upstream/warehouse-export-cookie';
export function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; exportId: string }> },
) {
  return requestApi(request, async () => {
    const { websiteId, exportId } = await params;
    const authenticated = authenticateWarehouseExport(request);
    const { website, auth } = await authorize(authenticated, websiteId);
    if (!['session', 'api-key'].includes(auth.authType)) throw new LiekanError('需要完整登录', 401);
    return downloadWarehouseExport(website.id, auth.user.id, exportId, request.signal, async () => {
      const current = await authorize(authenticated, websiteId);
      if (
        !['session', 'api-key'].includes(current.auth.authType) ||
        current.auth.user.id !== auth.user.id
      )
        throw new LiekanError('当前登录已失效', 401);
    });
  });
}
