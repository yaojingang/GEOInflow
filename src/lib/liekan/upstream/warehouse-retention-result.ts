import { getQueryFilters } from '@/lib/request';
import { getRetention } from '@/queries/sql/retention/getRetention';
import { readBrowserPopulation } from './browser-population';
import type { ReportQuery } from '../contracts/query';
import type { BrowserPopulation } from '../contracts/browser-population';
export type RetentionSnapshot = {
  kind: 'retention';
  rows: Awaited<ReturnType<typeof getRetention>>;
  population: BrowserPopulation;
  dataThrough: number;
};
export async function computeWarehouseRetention(
  site: string,
  p: ReportQuery,
  conditions: Record<string, unknown>,
  cutoff: number,
): Promise<RetentionSnapshot> {
  const query = {
    ...conditions,
    startAt: p.startAt,
    endAt: Math.min(p.endAt, cutoff),
    timezone: p.timezone,
  };
  // Resolve saved audience definitions at the pinned control version on every build.
  const filters = await getQueryFilters(query, site);
  if (!filters.startDate || !filters.endDate) throw new Error('warehouse-retention-range-invalid');
  const parameters = {
    ...query,
    ...filters,
    startDate: filters.startDate,
    endDate: filters.endDate,
  };
  const rows = await getRetention(site, parameters, filters);
  const population = await readBrowserPopulation(
    site,
    filters.startDate,
    filters.endDate,
    p.timezone,
  );
  return { kind: 'retention', rows, population, dataThrough: cutoff };
}
