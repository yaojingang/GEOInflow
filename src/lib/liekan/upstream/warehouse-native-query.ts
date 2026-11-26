import { DEFAULT_PAGE_SIZE } from '@/lib/constants';
import type { QueryFilters } from '@/lib/types';
import { identityUsable } from '../contracts/browser-population';
import { warehouseTime } from '../warehouse/fact-input';
import { applyNativePopulation, readBrowserPopulation } from './browser-population';
import { noteBrowserPopulation } from './cache-context';
import { geographyQueryParams, withClickHouseGeographySQL } from './geography-query';
import { nativeHourlyStats } from './warehouse-native-hours';
import { nativeRelations } from './warehouse-native-relations';
import {
  frozenCountKey,
  readFrozenCount,
  saveFrozenCount,
  warehouseReportResponse,
  warehouseReportStream,
  withinWarehouseReport,
} from './warehouse-report-snapshot';

// Only these audited queries restrict all event reads to the report/cohort windows.
// Other native queries may intentionally follow identities outside the selected range.
const boundedNativeQueries = new Set([
  'getWebsiteSessions',
  'getRetention',
  'getRealtimeActivity',
  'getRealtimeStats',
  'getPageviewStats',
  'getSessionStats',
  'getWebsiteStats',
]);
function nativeWindow(params: Record<string, unknown>, name?: string) {
  if (!boundedNativeQueries.has(name) || !params.startDate || !params.endDate) return;
  const starts = [+new Date(params.startDate as string)];
  const ends = [+new Date(params.endDate as string)];
  if (params.cohort_startDate || params.cohort_endDate) {
    starts.push(+new Date(params.cohort_startDate as string));
    ends.push(+new Date(params.cohort_endDate as string));
  }
  if (![...starts, ...ends].every(Number.isFinite)) return;
  return { start: Math.min(...starts), end: Math.max(...ends) };
}
function prepareNativeQuery(query: string, params: Record<string, unknown>, name?: string) {
  if (typeof params.websiteId !== 'string') throw new Error('warehouse-native-site-required');
  // An unqualified star can expose geographic fields; keep its complete shape.
  const relations = nativeRelations(
    /\b(?:country|region|city)\b|(?:select|,)\s*(?:[a-z_]+\.)?\*/i.test(query),
    nativeWindow(params, name),
    nativeHourlyStats(name, query, params, nativeWindow(params, name)),
  );
  // These relations already select the accepted version and deletion fences.
  query = query
    .replace(/\bsession_data\s+final\b/gi, 'session_data')
    .replace(/\buniq\(/g, 'uniqExact(')
    .replace(/\buniqArray\(/g, 'uniqExactArray(')
    .replace(/\bumami\.event_data_pivot\b/g, 'event_data_pivot');
  query = /^\s*with\b/i.test(query)
    ? query.replace(/^\s*with\b/i, `WITH ${relations.join(',')},`)
    : `WITH ${relations.join(',')} ${query}`;
  query = withClickHouseGeographySQL(query);
  const parameters = {
    ...Object.fromEntries(
      Object.entries(params).map(([key, value]) => [
        key,
        value instanceof Date ? warehouseTime(value) : value,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(geographyQueryParams()).filter(([key]) => query.includes(`{${key}:`)),
    ),
  };
  return { query, parameters };
}

/** Narrow streaming path for native string identity columns. Numeric native
 * reports keep their existing typed JSON conversion in warehouseNativeQuery. */
export async function warehouseNativeStringStream<T extends Record<string, string | null>>(
  sql: string,
  params: Record<string, unknown>,
  consume: (rows: T[]) => Promise<void>,
  signal?: AbortSignal,
) {
  const prepared = prepareNativeQuery(sql, params);
  return warehouseReportStream<T>(
    String(params.websiteId),
    `${prepared.query.trim().replace(/;$/, '')} SETTINGS group_by_use_nulls=1`,
    prepared.parameters,
    consume,
    signal,
  );
}

// Adapt the upstream query vocabulary to the versioned Liekan relations. The
// callers still own their SQL and permission checks; no upstream CH connection,
// approximate deduplication or PostgreSQL fact fallback is involved.
export async function warehouseNativeQuery<T = unknown>(
  query: string,
  params: Record<string, unknown>,
  _name?: string,
): Promise<T> {
  return withinWarehouseReport(async () => {
    if (!params.websiteId && Array.isArray(params.websiteIds) && _name === 'getWebsiteListCharts') {
      const rows: unknown[] = [];
      for (const websiteId of params.websiteIds)
        rows.push(
          ...(await warehouseNativeQuery<unknown[]>(query, { ...params, websiteId }, _name)),
        );
      return rows as T;
    }
    const prepared = prepareNativeQuery(query, params, _name);
    query = prepared.query;
    const site = String(params.websiteId);
    const response = await warehouseReportResponse<{
      meta: { name: string; type: string }[];
      data: Record<string, unknown>[];
    }>(site, query, prepared.parameters, 'JSON');
    let rows = response.data.map(row =>
      Object.fromEntries(
        response.meta.map(column => {
          const value = row[column.name],
            type = column.type.replace(/^Nullable\((.*)\)$/, '$1');
          if (
            value !== null &&
            (/^(U?Int\d+|Float\d+)$/.test(type) ||
              (type.startsWith('Decimal') && ['totaltime', 'duration'].includes(column.name)))
          ) {
            const n = Number(value);
            if (/Float/.test(type) && !Number.isFinite(n)) return [column.name, null];
            if (!Number.isFinite(n) || (/Int/.test(type) && !Number.isSafeInteger(n)))
              throw new Error('warehouse-native-number-out-of-range');
            return [column.name, n];
          }
          return [column.name, value];
        }),
      ),
    );
    if (params.startDate && _name) {
      const population = await readBrowserPopulation(
        site,
        new Date(params.startDate as string),
        params.endDate ? new Date(params.endDate as string) : new Date(),
        String(params.timezone ?? 'UTC'),
      );
      noteBrowserPopulation(site, population);
      rows = applyNativePopulation(rows, _name, population);
    }
    return rows as T;
  });
}

export function withWarehouseNativeRead<T>(
  _params: Record<string, unknown>,
  _name: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return withinWarehouseReport(work);
}

export async function warehouseNativePage(
  query: string,
  params: Record<string, unknown>,
  filters: QueryFilters,
  name?: string,
) {
  return withWarehouseNativeRead(params, name, async () => {
    const page = Number(filters.page ?? 1),
      pageSize = Number(filters.pageSize ?? DEFAULT_PAGE_SIZE),
      offset = (page - 1) * pageSize;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      !Number.isSafeInteger(offset)
    )
      throw new Error('warehouse-invalid-page');
    const order = filters.orderBy;
    if (order && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(order))
      throw new Error('warehouse-invalid-order');
    const body = query.trim().replace(/;$/, '');
    let count: number, data: unknown[];
    if (name === 'getWebsiteSessions') {
      const countKey = await frozenCountKey(String(params.websiteId), body, params);
      const knownCount = readFrozenCount(countKey);
      const rows = await warehouseNativeQuery<Record<string, unknown>[]>(
        `SELECT *${knownCount === undefined ? ',count() OVER () AS _liekan_page_count' : ''} FROM (${body}) ${order ? `ORDER BY "${order}" ${filters.sortDescending ? 'DESC' : 'ASC'},id` : 'ORDER BY createdAt DESC,id'} LIMIT {wh_page_size:UInt64} OFFSET {wh_page_offset:UInt64}`,
        { ...params, wh_page_size: pageSize, wh_page_offset: offset },
        name,
      );
      count =
        knownCount ??
        (rows.length
          ? Number(rows[0]._liekan_page_count)
          : offset > 0
            ? (
                await warehouseNativeQuery<{ num: number }[]>(
                  `SELECT count() AS num FROM (${body})`,
                  params,
                  name,
                )
              )[0].num
            : 0);
      saveFrozenCount(countKey, count);
      data = rows.map(({ _liekan_page_count, ...row }) => row);
    } else {
      [{ num: count }] = await warehouseNativeQuery<{ num: number }[]>(
        `SELECT count() AS num FROM (${body})`,
        params,
      );
      data = await warehouseNativeQuery<unknown[]>(
        `SELECT * FROM (${body}) ${order ? `ORDER BY "${order}" ${filters.sortDescending ? 'DESC' : 'ASC'}` : ''} LIMIT {wh_page_size:UInt64} OFFSET {wh_page_offset:UInt64}`,
        { ...params, wh_page_size: pageSize, wh_page_offset: offset },
        name,
      );
    }
    const population =
      params.websiteId && params.startDate && params.endDate
        ? await readBrowserPopulation(
            String(params.websiteId),
            new Date(params.startDate as string),
            new Date(params.endDate as string),
            String(params.timezone ?? 'UTC'),
          )
        : undefined;
    const unavailable =
      [
        'getWebsiteSessions',
        'getSessionDataPivot',
        'getRevenueSessions',
        'getSessionReplays',
      ].includes(name) && !identityUsable(population);
    return {
      data: unavailable ? [] : data,
      count: unavailable ? null : count,
      page,
      pageSize,
      orderBy: order,
      search: filters.search,
      isCapped: false,
      ...(population ? { population } : {}),
    };
  });
}
