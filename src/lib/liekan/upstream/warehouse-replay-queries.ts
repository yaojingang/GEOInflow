import { gunzipSync } from 'node:zlib';
import clickhouse from '@/lib/clickhouse';
import { DEFAULT_PAGE_SIZE } from '@/lib/constants';
import { getClickHouseCountrySQL } from '@/lib/country';
import type { IdentityPageResult, QueryFilters, SessionReplaySummary } from '@/lib/types';
import type { ReplayChunk } from '@/queries/sql/replays/getReplayChunks';
import { identityUsable } from '../contracts/browser-population';
import { readBrowserPopulation } from './browser-population';
import { warehouseNativeQuery } from './warehouse-native-query';
import { withinWarehouseReport } from './warehouse-report-snapshot';

export async function warehouseReplayChunks(
  websiteId: string,
  visitId: string,
  { endAt, endChunkIndex }: { endAt?: Date; endChunkIndex?: number },
): Promise<ReplayChunk[]> {
  const rows = await warehouseNativeQuery<Record<string, string>[]>(
    `SELECT session_id,visit_id,events,
    chunk_index,event_count,started_at,ended_at FROM session_replay
    WHERE website_id={websiteId:UUID} AND visit_id={visitId:UUID}
      AND (session_id,visit_id) IN (SELECT session_id,visit_id FROM website_event)
      ${endAt ? 'AND started_at<={endAt:DateTime64(6)}' : ''}
      ${endChunkIndex !== undefined ? 'AND chunk_index<={endChunkIndex:Int32}' : ''}
    ORDER BY chunk_index,started_at,replay_id`,
    { websiteId, visitId, endAt, endChunkIndex },
  );
  return rows.map(r => ({
    sessionId: r.session_id,
    visitId: r.visit_id,
    events: JSON.parse(gunzipSync(Buffer.from(r.events, 'hex')).toString('utf8')),
    chunkIndex: Number(r.chunk_index),
    eventCount: Number(r.event_count),
    startedAt: new Date(r.started_at.replace(' ', 'T') + 'Z'),
    endedAt: new Date(r.ended_at.replace(' ', 'T') + 'Z'),
  }));
}

export async function warehouseSessionReplays(
  websiteId: string,
  filters: QueryFilters,
  sessionId?: string,
): Promise<IdentityPageResult<SessionReplaySummary[]>> {
  return withinWarehouseReport(async () => {
    const { filterQuery, cohortQuery, excludeBounceQuery, queryParams } = clickhouse.parseFilters({
      ...filters,
      websiteId,
    });
    const page = Number(filters.page ?? 1),
      pageSize = Number(filters.pageSize ?? DEFAULT_PAGE_SIZE);
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      !Number.isSafeInteger((page - 1) * pageSize)
    )
      throw new Error('warehouse-invalid-page');
    const order = filters.orderBy ?? 'createdAt';
    if (
      ![
        'id',
        'sessionId',
        'websiteId',
        'browser',
        'os',
        'device',
        'country',
        'city',
        'eventCount',
        'chunkCount',
        'startedAt',
        'endedAt',
        'duration',
        'createdAt',
      ].includes(order)
    )
      throw new Error('warehouse-invalid-order');
    const sql = `SELECT sr.visit_id AS id,sr.session_id AS sessionId,sr.website_id AS websiteId,
      e.dimensions.1 AS browser,e.dimensions.2 AS os,e.dimensions.3 AS device,
      ${getClickHouseCountrySQL('e.dimensions.4')} AS country,e.dimensions.5 AS city,
      sum(sr.event_count) AS eventCount,count() AS chunkCount,min(sr.started_at) AS startedAt,
      max(sr.ended_at) AS endedAt,sum(toUnixTimestamp64Milli(sr.ended_at)-toUnixTimestamp64Milli(sr.started_at)) AS duration,
      max(sr.created_at) AS createdAt FROM session_replay sr INNER JOIN (
        SELECT website_id,session_id,visit_id,argMax(tuple(browser,os,device,country,city,distinct_id),tuple(created_at,event_id)) AS dimensions
        FROM website_event ${cohortQuery} ${excludeBounceQuery}
        WHERE website_id={websiteId:UUID} AND created_at BETWEEN {startDate:DateTime64(6)} AND {endDate:DateTime64(6)} ${filterQuery}
        GROUP BY website_id,session_id,visit_id
      ) e ON e.website_id=sr.website_id AND e.session_id=sr.session_id AND e.visit_id=sr.visit_id
      WHERE sr.created_at BETWEEN {startDate:DateTime64(6)} AND {endDate:DateTime64(6)}
        ${sessionId ? 'AND sr.session_id={sessionId:UUID}' : ''}
        ${filters.search ? `AND arrayExists(v->positionCaseInsensitive(coalesce(v,''),{search:String})>0,[e.dimensions.1,e.dimensions.2,e.dimensions.3,e.dimensions.5,e.dimensions.6])` : ''}
      GROUP BY sr.visit_id,sr.session_id,sr.website_id,e.dimensions
      ${filters.minDuration > 0 ? 'HAVING duration>={minDurationMs:Float64}' : ''}`;
    const parameters = {
      ...queryParams,
      websiteId,
      sessionId,
      startDate: filters.startDate,
      endDate: filters.endDate,
      search: filters.search,
      minDurationMs: (filters.minDuration ?? 0) * 1000,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    };
    const [{ n }] = await warehouseNativeQuery<{ n: string }[]>(
      `SELECT count() n FROM (${sql})`,
      parameters,
    );
    const rows = await warehouseNativeQuery<(SessionReplaySummary & Record<string, unknown>)[]>(
      `${sql}
      ORDER BY "${order}" ${filters.sortDescending === false && filters.orderBy ? 'ASC' : 'DESC'},id
      LIMIT {limit:UInt64} OFFSET {offset:UInt64}`,
      parameters,
    );
    const number = (value: unknown) => {
      const n = Number(value);
      if (!Number.isSafeInteger(n)) throw new Error('warehouse-count-out-of-range');
      return n;
    };
    const population = await readBrowserPopulation(
      websiteId,
      filters.startDate,
      filters.endDate,
      filters.timezone,
    );
    return {
      data: rows.map(r => ({
        ...r,
        eventCount: number(r.eventCount),
        chunkCount: number(r.chunkCount),
        duration: number(r.duration),
      })),
      count: identityUsable(population) ? number(n) : null,
      page,
      pageSize,
      orderBy: filters.orderBy,
      search: filters.search,
      isCapped: false,
      population,
    };
  });
}
