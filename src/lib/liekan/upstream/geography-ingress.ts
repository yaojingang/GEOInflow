import prisma from '@/lib/prisma';

export async function recordGeographyIngress(
  websiteId: string,
  reason: 'blocked_ip' | 'invalid_ip',
) {
  if (!websiteId) return;
  try {
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
