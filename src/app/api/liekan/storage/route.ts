import { readBody, requestApi } from '@/lib/liekan/http';
import {
  storageActionResponse,
  storageStateResponse,
} from '@/lib/liekan/upstream/storage-retention-api';
export async function GET(request: Request) {
  return requestApi(request, () => storageStateResponse(request));
}
export async function POST(request: Request) {
  return requestApi(request, async () =>
    storageActionResponse(request, await readBody(request, 8192)),
  );
}
