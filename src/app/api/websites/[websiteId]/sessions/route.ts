import { z } from 'zod';
import { withSessionReadBoundary } from '@/lib/liekan/upstream/warehouse-session-boundary';
import { withQueryCacheHeaders } from '@/lib/liekan/upstream/cache-context';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { filterParams, pagingParams, searchParams, withDateRange } from '@/lib/schema';
import { canViewWebsiteSection } from '@/permissions';
import { getWebsiteSessions } from '@/queries/sql';

async function getResponse(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = withDateRange({
    readBoundary: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    ...filterParams,
    ...pagingParams,
    ...searchParams,
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canViewWebsiteSection(auth, websiteId, 'sessions'))) {
    return unauthorized();
  }

  const filters = await getQueryFilters(query, websiteId);

  const data = await withSessionReadBoundary(websiteId, query, () =>
    getWebsiteSessions(websiteId, filters),
  );

  return json(data);
}

export async function GET(...args: Parameters<typeof getResponse>) {
  return withQueryCacheHeaders(() => getResponse(...args), args[0]);
}
