import { readBody, requestApi } from '@/lib/liekan/http';
import {
  storageActionResponse,
  storageStateResponse,
} from '@/lib/liekan/upstream/storage-retention-api';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  return requestApi(request, async () => storageStateResponse(request, (await params).websiteId));
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  return requestApi(request, async () =>
    storageActionResponse(request, await readBody(request, 8192), (await params).websiteId),
  );
}
