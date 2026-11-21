import { warehouseEnabled } from '@/lib/liekan/warehouse/authority-routing';
import { requestWarehouseRetention } from '@/lib/liekan/upstream/warehouse-overview-snapshots';
import { authorize } from '@/lib/liekan/upstream/server';
import { requestApi } from '@/lib/liekan/http';
import {
  analysisAsyncRequested,
  asyncAnalysisResponse,
} from '@/lib/liekan/upstream/analysis-query-api';
import { withQueryCacheHeaders } from '@/lib/liekan/upstream/cache-context';
import { retentionQuerySchema } from '@/lib/analytics-schema';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { canViewWebsiteSection } from '@/permissions';
import { getRetention, type RetentionParameters } from '@/queries/sql/retention/getRetention';

async function getResponse(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, query, error } = await parseRequest(request, retentionQuerySchema);
  if (error) return error();
  const { websiteId } = await params;
  if (!(await canViewWebsiteSection(auth, websiteId, 'retention'))) return unauthorized();
  if (warehouseEnabled() && auth?.user)
    return requestWarehouseRetention(await authorize(request, websiteId), query, request.signal);
  const filters = await getQueryFilters(query, websiteId);
  const parameters = { ...query, ...filters } as RetentionParameters;
  return json(await getRetention(websiteId, parameters, filters));
}

export async function GET(...args: Parameters<typeof getResponse>) {
  if (analysisAsyncRequested(args[0], 'native:retention'))
    return requestApi(args[0], async () =>
      asyncAnalysisResponse(args[0], (await args[1].params).websiteId, 'native:retention'),
    );

  if (warehouseEnabled()) return requestApi(args[0], () => getResponse(...args));
  return withQueryCacheHeaders(() => getResponse(...args), args[0]);
}
