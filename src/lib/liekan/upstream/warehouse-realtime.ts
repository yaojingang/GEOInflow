import clickhouse from '@/lib/clickhouse';
import type { QueryFilters } from '@/lib/types';
import { identityUsable } from '../contracts/browser-population';
import { warehouseEnabled } from '../warehouse/authority-routing';
import { readBrowserPopulation } from './browser-population';
import { warehouseNativeQuery, withWarehouseNativeRead } from './warehouse-native-query';

export const warehouseRealtimeEnabled = warehouseEnabled;

/** One accepted event scan produces bucket PV/UV and exact window UV. The
 * grouping set for the window deduplicates across buckets, never sums UV. */
export async function warehouseRealtimeStats(websiteId: string, filters: QueryFilters) {
  const { timezone = 'UTC', unit = 'day' } = filters;
  const { filterQuery, cohortQuery, excludeBounceQuery, queryParams } = clickhouse.parseFilters({
    ...filters,
    websiteId,
  });
  return withWarehouseNativeRead(queryParams, 'getRealtimeStats', async () => {
    const rows = await warehouseNativeQuery<
      { x: string; views: number; visitors: number; total: number }[]
    >(
      `SELECT ${clickhouse.getDateSQL('website_event.created_at', unit, timezone)} AS x,
        count(*) AS views,uniqExact(session_id) AS visitors,GROUPING(x) AS total
      FROM website_event ${cohortQuery} ${excludeBounceQuery}
      WHERE website_id={websiteId:UUID}
        AND created_at BETWEEN {startDate:DateTime64} AND {endDate:DateTime64}
        AND event_type NOT IN (2,5) ${filterQuery}
      GROUP BY GROUPING SETS ((x),()) ORDER BY total,x`,
      queryParams,
      'getRealtimeStats',
    );
    const population = await readBrowserPopulation(
      websiteId,
      filters.startDate,
      filters.endDate,
      timezone,
    );
    const usable = identityUsable(population);
    const buckets = rows.filter(row => !row.total);
    return {
      pageviews: buckets.map(row => ({ x: row.x, y: row.views })),
      sessions: buckets.map(row => ({ x: row.x, y: usable ? row.visitors : null })),
      totals: {
        visitors: usable ? (rows.find(row => row.total)?.visitors ?? 0) : null,
        population,
      },
    };
  });
}
