import { normalizeCollectionHostname } from './collection-quality';

export interface CollectionAdmission {
  revision: string;
  mode: string;
  allowedHostnames: string[];
}
export function normalizeCollectionOrigin(value: string | null) {
  if (!value || value === 'null') return null;
  try {
    const origin = new URL(value);
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      return null;
    return normalizeCollectionHostname(origin.hostname);
  } catch {
    return null;
  }
}
export function conflictsWithCollectionHosts(
  policy: CollectionAdmission,
  hostname: string | null,
  originHostname: string | null,
) {
  return (
    policy.allowedHostnames.length > 0 &&
    (!hostname ||
      !policy.allowedHostnames.includes(hostname) ||
      (originHostname !== null && !policy.allowedHostnames.includes(originHostname)))
  );
}
const ADMISSION_TTL_MS = 2000;
const admissionCache = new Map<string, { value: CollectionAdmission; expiresAt: number }>();

export async function collectionAdmission(websiteId: string): Promise<CollectionAdmission> {
  const now = Date.now();
  const hit = admissionCache.get(websiteId);
  if (hit && hit.expiresAt > now) return hit.value;

  const { default: prisma, getRawQueryClient } = await import('@/lib/prisma');
  const primary = getRawQueryClient(prisma.client, { write: true }) as any;
  const [row] = await primary.$queryRawUnsafe(
    'SELECT revision::text,mode,allowed_hostnames FROM liekan_collection_policy WHERE website_id=$1::uuid',
    websiteId,
  );
  const value: CollectionAdmission = {
    revision: row?.revision ?? '0',
    mode: row?.mode ?? 'standard',
    allowedHostnames: row?.allowed_hostnames ?? [],
  };
  if (admissionCache.size >= 512) admissionCache.clear();
  admissionCache.set(websiteId, { value, expiresAt: now + ADMISSION_TTL_MS });
  return value;
}
