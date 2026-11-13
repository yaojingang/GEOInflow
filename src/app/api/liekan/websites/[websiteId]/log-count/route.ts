import { logReadResponse } from '@/lib/liekan/upstream/log-read-api';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  return logReadResponse(request, (await params).websiteId, 'count');
}
