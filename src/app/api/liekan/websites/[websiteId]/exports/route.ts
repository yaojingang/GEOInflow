import { requestApi, readBody } from '@/lib/liekan/http';
import { authorize } from '@/lib/liekan/upstream/server';
import { prepareFeatureExport } from '@/lib/liekan/upstream/feature-exports';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  return requestApi(request, async () => {
    const { websiteId } = await params;
    const { website } = await authorize(request, websiteId);
    return prepareFeatureExport(website, await readBody(request), request.signal);
  });
}
