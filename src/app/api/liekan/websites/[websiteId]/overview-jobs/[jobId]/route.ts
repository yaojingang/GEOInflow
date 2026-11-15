import { requestApi } from '@/lib/liekan/http';
import { authorize, LiekanError } from '@/lib/liekan/upstream/server';
import { readWarehouseOverviewJob } from '@/lib/liekan/upstream/warehouse-overview-snapshots';
import { warehouseEnabled } from '@/lib/liekan/warehouse/authority-routing';
import { z } from 'zod';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; jobId: string }> },
) {
  return requestApi(request, async () => {
    const { websiteId, jobId } = await params;
    const access = await authorize(request, websiteId);
    if (!warehouseEnabled() || !z.uuid().safeParse(jobId).success)
      throw new LiekanError('统计任务不存在', 404);
    return readWarehouseOverviewJob(
      access,
      jobId,
      false,
      new URL(request.url).searchParams,
      request.signal,
    );
  });
}
