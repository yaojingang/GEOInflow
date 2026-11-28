import { warehouseEnabled } from '@/lib/liekan/warehouse/authority-routing';
import { readBody, requestApi } from '@/lib/liekan/http';
import { authorize } from '@/lib/liekan/upstream/server';
import {
  actOnTrafficExclusion,
  trafficGovernanceState,
} from '@/lib/liekan/upstream/traffic-exclusions';
import { qualityReadTransaction } from '@/lib/liekan/upstream/traffic-quality';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  return requestApi(request, async () => {
    const { websiteId } = await params;
    const { website, writeIdentity } = await authorize(request, websiteId, true);
    return actOnTrafficExclusion(website.id, await readBody(request, 64 * 1024), writeIdentity);
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  return requestApi(request, async () => {
    const { websiteId } = await params;
    const { website } = await authorize(request, websiteId);
    if (warehouseEnabled())
      return (
        await import('@/lib/liekan/upstream/warehouse-traffic-quality')
      ).warehouseTrafficGovernanceState(
        website.id,
        new URL(request.url).searchParams.get('cursor') || undefined,
      );
    return qualityReadTransaction(tx =>
      trafficGovernanceState(
        tx,
        website.id,
        new URL(request.url).searchParams.get('cursor') || undefined,
      ),
    );
  });
}
