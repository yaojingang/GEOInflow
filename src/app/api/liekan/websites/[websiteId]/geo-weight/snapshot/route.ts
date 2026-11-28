import { geoSnapshotApi } from '@/lib/liekan/upstream/geo-weight-snapshot-http';
import { readGeoWeightSnapshot } from '@/lib/liekan/upstream/geo-weight-snapshots';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  return geoSnapshotApi(request, async actor => {
    const { websiteId } = await params;
    const search = new URL(request.url).searchParams;
    const fresh = search.get('refresh') === '1';
    search.delete('refresh');
    return readGeoWeightSnapshot(actor, websiteId, Object.fromEntries(search), {
      signal: request.signal,
      fresh,
    });
  });
}
