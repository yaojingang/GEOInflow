import { api, readBody } from '@/lib/liekan/http';
import { changeAnalyticsEngine, getAnalyticsEngine } from '@/lib/liekan/upstream/analytics-engine';

export async function GET(request: Request) {
  return api(
    () => getAnalyticsEngine(request),
    () => ({}),
    request,
  );
}
export async function POST(request: Request) {
  return api(
    async () => changeAnalyticsEngine(request, await readBody(request, 4096)),
    () => ({}),
    request,
  );
}
