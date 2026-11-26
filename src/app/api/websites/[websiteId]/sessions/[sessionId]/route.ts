import { nativeSnapshot } from '@/lib/liekan/upstream/native-snapshot';
import { api } from '@/lib/liekan/http';
import { identityUsable } from '@/lib/liekan/contracts/browser-population';
import { withQueryCacheHeaders } from '@/lib/liekan/upstream/cache-context';
import { isRelationalOnly } from '@/lib/db';
import { parseRequest } from '@/lib/request';
import { badRequest, json, notFound, ok, unauthorized } from '@/lib/response';
import { canDeleteWebsite, canViewWebsiteSection } from '@/permissions';
import { deleteSession } from '@/queries/prisma';
import { getLinkedDistinctIds, getLinkedSessionIds, getWebsiteSession } from '@/queries/sql';

async function getResponse(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; sessionId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId, sessionId } = await params;
  const canDelete = isRelationalOnly() && (await canDeleteWebsite(auth, websiteId));

  if (
    !(await canViewWebsiteSection(auth, websiteId, ['sessions', 'events', 'realtime', 'revenue']))
  ) {
    return unauthorized();
  }

  const data = await getWebsiteSession(websiteId, sessionId);

  if (!data) {
    return notFound();
  }

  if (!identityUsable(data.population)) {
    return json({
      ...data,
      distinctId: undefined,
      canDelete,
      distinctIds: [],
      stitchedSessionCount: null,
    });
  }

  let sessionIds = [sessionId];
  const linkedDistinctIds = await getLinkedDistinctIds(websiteId, sessionId);
  const distinctIds = linkedDistinctIds.length
    ? linkedDistinctIds
    : data.distinctId
      ? [data.distinctId]
      : [];
  const distinctId = distinctIds.length === 1 ? distinctIds[0] : undefined;

  // A collided legacy session cannot be safely attributed to one identity.
  data.distinctId = distinctId;

  if (distinctId) {
    const links = await getLinkedSessionIds(websiteId, distinctId);
    const linkedIds = links.map(link => link.sessionId);

    sessionIds = Array.from(new Set([sessionId, ...linkedIds]));
  }

  const stitchedSessionCount = sessionIds.length;

  return json({
    ...data,
    canDelete,
    distinctIds,
    stitchedSessionCount,
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; sessionId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  if (!isRelationalOnly()) {
    return badRequest({ message: 'Session deletion is only available with relational storage.' });
  }

  const { websiteId, sessionId } = await params;

  if (!(await canDeleteWebsite(auth, websiteId))) {
    return unauthorized();
  }

  return api(async () => {
    const deletedSession = await deleteSession(websiteId, sessionId, { userId: auth.user.id });

    if (!deletedSession) return notFound();

    return ok();
  });
}

export async function GET(...args: Parameters<typeof getResponse>) {
  return withQueryCacheHeaders(() => nativeSnapshot(() => getResponse(...args)), args[0]);
}
