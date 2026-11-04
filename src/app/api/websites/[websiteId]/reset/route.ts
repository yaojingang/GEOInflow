import { LiekanError } from '@/lib/liekan/upstream/server';
import { api } from '@/lib/liekan/http';
import { parseRequest } from '@/lib/request';
import { forbidden, notFound, ok, unauthorized } from '@/lib/response';
import { canUpdateWebsite } from '@/permissions';
import { resetWebsite } from '@/queries/prisma';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  return api(async () => {
    try {
      await resetWebsite(websiteId, { userId: auth.user.id });
    } catch (error) {
      if (error instanceof LiekanError) {
        if (error.status === 403) return forbidden();
        if (error.status === 401) return unauthorized();
        if (error.status === 404) return notFound();
      }
      throw error;
    }

    return ok();
  });
}
