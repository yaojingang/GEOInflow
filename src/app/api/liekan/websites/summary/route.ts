import { api } from '@/lib/liekan/http';
import { withQueryCacheHeaders } from '@/lib/liekan/upstream/cache-context';
import { withReadDiagnostics } from '@/lib/liekan/upstream/report-read-diagnostics';
import { readWebsiteSummary } from '@/lib/liekan/upstream/website-summary';

export async function GET(request: Request) {
  return withReadDiagnostics(
    () =>
      withQueryCacheHeaders(
        () =>
          api(async () => {
            const rows = await readWebsiteSummary(
              request,
              Object.fromEntries(new URL(request.url).searchParams),
            );
            if (!rows.some(row => row.snapshot)) return rows;
            const pending = rows.some(row => row.snapshot?.state === 'preparing');
            return Response.json(rows, {
              status: pending ? 202 : 200,
              headers: {
                'X-Liekan-Read-Path': pending ? 'preparing' : 'published',
              },
            });
          }),
        request,
      ),
    true,
  );
}
