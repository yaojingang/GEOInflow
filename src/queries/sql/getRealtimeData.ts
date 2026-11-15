import { nativeSnapshot } from '@/lib/liekan/upstream/native-snapshot';
import { identityUsable } from '@/lib/liekan/contracts/browser-population';
import { getWebsiteStats } from './getWebsiteStats';
import { normalizeCountryCode } from '@/lib/country';
import type { QueryFilters, RealtimeActivity, RealtimeData, RealtimeEvent } from '@/lib/types';
import { getRealtimeActivity } from '@/queries/sql/getRealtimeActivity';
import { getPageviewStats } from '@/queries/sql/pageviews/getPageviewStats';
import { getSessionStats } from '@/queries/sql/sessions/getSessionStats';
import {
  warehouseRealtimeEnabled,
  warehouseRealtimeStats,
} from '@/lib/liekan/upstream/warehouse-realtime';

function increment(data: object, key?: string | null) {
  if (key) {
    if (!data[key]) {
      data[key] = 1;
    } else {
      data[key] += 1;
    }
  }
}

export async function getRealtimeData(
  websiteId: string,
  filters: QueryFilters,
): Promise<RealtimeData> {
  return process.env.CLICKHOUSE_URL
    ? computeRealtimeData(websiteId, filters)
    : nativeSnapshot(() => computeRealtimeData(websiteId, filters));
}
async function computeRealtimeData(
  websiteId: string,
  filters: QueryFilters,
): Promise<RealtimeData> {
  const [activity, { pageviews, sessions, totals }] = await Promise.all([
    getRealtimeActivity(websiteId, filters),
    warehouseRealtimeEnabled()
      ? warehouseRealtimeStats(websiteId, filters)
      : Promise.all([
          getPageviewStats(websiteId, filters),
          getSessionStats(websiteId, filters),
          getWebsiteStats(websiteId, filters),
        ]).then(([pageviews, sessions, totals]) => ({ pageviews, sessions, totals })),
  ]);

  const uniques = new Set();

  const { countries, urls, referrers, events } = activity.reverse().reduce(
    (
      obj: {
        countries: Record<string, number>;
        urls: Record<string, number>;
        referrers: Record<string, number>;
        events: RealtimeEvent[];
      },
      event: RealtimeActivity,
    ) => {
      const { countries, urls, referrers, events } = obj;
      const { sessionId, urlPath, referrerDomain, eventName } = event;
      const country = normalizeCountryCode(event.country);
      const normalizedEvent = { ...event, country };

      if (identityUsable(totals.population) && !uniques.has(sessionId)) {
        uniques.add(sessionId);
        increment(countries, country);

        events.push({ __type: 'session', ...normalizedEvent });
      }

      increment(urls, urlPath);
      increment(referrers, referrerDomain);

      events.push({ __type: eventName ? 'event' : 'pageview', ...normalizedEvent });

      return obj;
    },
    {
      countries: {},
      urls: {},
      referrers: {},
      events: [],
    },
  );

  return {
    population: totals.population,
    countries,
    urls,
    referrers,
    events: events.reverse(),
    series: {
      views: pageviews,
      visitors: sessions,
    },
    totals: {
      views: pageviews.reduce((sum: number, { y }: { y: number }) => Number(sum) + Number(y), 0),
      visitors: process.env.CLICKHOUSE_URL
        ? sessions.reduce((sum: number, { y }: { y: number }) => Number(sum) + Number(y), 0)
        : totals.visitors,
      events: activity.filter(e => e.eventName).length,
      countries: Object.keys(countries).length,
    },
    timestamp: Date.now(),
  };
}
