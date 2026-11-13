import { createHash, randomUUID } from 'node:crypto';
import prisma from '@/lib/prisma';
import { warehouseIntakeEnabled, warehouseRuntime } from '../warehouse/runtime';
export async function recordGeographyIngress(
  websiteId: string,
  reason: 'blocked_ip' | 'invalid_ip',
) {
  if (!websiteId) return;
  try {
    if (warehouseIntakeEnabled()) {
      const runtime = await warehouseRuntime(),
        site = await runtime.resource(websiteId, 'website');
      const envelope = runtime.envelope(site, {
        websiteId,
        sessionId: randomUUID(),
        visitId: randomUUID(),
        eventId: randomUUID(),
        kind: 'ingress',
        fingerprint: createHash('sha256').update(reason).digest('hex'),
        collectionSource: 'ingress',
        collectionScope: 'ingress',
        receivedAt: new Date().toISOString(),
        data: { format: 'ingress-v1', reason },
      });
      await runtime.queue.enqueue(envelope);
      return;
    }
    await prisma.client.$executeRawUnsafe(
      `INSERT INTO liekan_geography_ingress(website_id,bucket,reason,count)
       SELECT $1::uuid,date_trunc('minute',clock_timestamp()),$2,1 WHERE EXISTS(SELECT 1 FROM website WHERE website_id=$1::uuid AND deleted_at IS NULL)
       ON CONFLICT(website_id,bucket,reason) DO UPDATE SET count=liekan_geography_ingress.count+1`,
      websiteId,
      reason,
    );
  } catch {
    /* Aggregate diagnostics cannot alter collection acceptance. */
  }
}
