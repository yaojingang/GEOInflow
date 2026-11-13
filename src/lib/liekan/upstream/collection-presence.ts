import { query } from './server';
import { LiekanError } from './errors';
import { warehouseEnabled } from '../warehouse/authority-routing';

export async function collectionPresence(websiteId: string) {
  if (warehouseEnabled())
    return (await import('./warehouse-presence')).warehouseCollectionPresence(websiteId);
  if (process.env.CLICKHOUSE_URL) {
    const { getWebsiteStats, getWebsiteDateRange } = await import('@/queries/sql');
    const [website] = await query(
      'SELECT created_at FROM website WHERE website_id=$1::uuid',
      websiteId,
    );
    const [stats, dates] = await Promise.all([
      getWebsiteStats(websiteId, {
        startDate: website?.created_at || new Date(0),
        endDate: new Date(),
      }),
      getWebsiteDateRange(websiteId),
    ]);
    const data: unknown = stats;
    const pageviews =
      data && typeof data === 'object' && !Array.isArray(data) && 'pageviews' in data
        ? Number(data.pageviews)
        : NaN;
    if (!Number.isSafeInteger(pageviews) || pageviews < 0)
      throw new LiekanError('浏览采集状态契约不兼容', 500);
    return {
      pageviews,
      firstAt: dates?.startDate ? new Date(dates.startDate).toISOString() : null,
      lastAt: dates?.endDate ? new Date(dates.endDate).toISOString() : null,
    };
  }
  const [row] = await query(
    `SELECT count(*)::int AS pageviews,min(created_at) AS "firstAt",max(created_at) AS "lastAt"
     FROM liekan_raw_website_event WHERE website_id=$1::uuid AND event_type=1
     AND created_at BETWEEN (SELECT created_at FROM website WHERE website_id=$1::uuid) AND now()`,
    websiteId,
  );
  return {
    pageviews: Number(row?.pageviews || 0),
    firstAt: row?.firstAt ? new Date(row.firstAt).toISOString() : null,
    lastAt: row?.lastAt ? new Date(row.lastAt).toISOString() : null,
  };
}
