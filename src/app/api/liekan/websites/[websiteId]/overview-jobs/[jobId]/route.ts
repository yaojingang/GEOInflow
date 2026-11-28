import { requestApi } from '@/lib/liekan/http';
import { authorize, LiekanError } from '@/lib/liekan/upstream/server';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; jobId: string }> },
) {
  return requestApi(request, async () => {
    const { websiteId } = await params;
    await authorize(request, websiteId);
    throw new LiekanError('统计任务不存在', 404);
  });
}
