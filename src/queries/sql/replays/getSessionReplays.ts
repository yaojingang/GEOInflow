import clickhouse from '@/lib/clickhouse';
import { getClickHouseCountrySQL, getPostgresCountrySQL } from '@/lib/country';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import { warehouseSessionReplays } from '@/lib/liekan/upstream/warehouse-replay-queries';
import { warehouseEnabled } from '@/lib/liekan/warehouse/runtime';
import prisma from '@/lib/prisma';
import type { IdentityPageResult, QueryFilters, SessionReplaySummary } from '@/lib/types';

const FUNCTION_NAME = 'getSessionReplays';

export function getSessionReplays(
  ...args: [websiteId: string, filters: QueryFilters, sessionId?: string]
): Promise<IdentityPageResult<SessionReplaySummary[]>> {
  if (warehouseEnabled()) return warehouseSessionReplays(...args);
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(websiteId: string, filters: QueryFilters, sessionId?: string) {
  const { pagedRawQuery, parseFilters } = prisma;
  const { search, minDuration } = filters;
  const minDurationMs = minDuration && minDuration > 0 ? minDuration * 1000 : undefined;
  const { filterQuery, cohortQuery, queryParams, joinSessionQuery } = parseFilters({
    ...filters,
    websiteId,
    search: search ? `%${search}%` : undefined,
  });

  const joinQuery =
    filterQuery || cohortQuery
      ? `join (select distinct website_event.website_id, website_event.session_id, website_event.visit_id
               from website_event
               ${joinSessionQuery}
               ${cohortQuery}
               where website_event.website_id = {{websiteId::uuid}}
                  and website_event.created_at between {{startDate}} and {{endDate}}
                  ${filterQuery}) website_event
        on website_event.website_id = sr.website_id
          and website_event.session_id = sr.session_id
          and website_event.visit_id = sr.visit_id`
      : '';

  const sessionFilter = sessionId ? 'and sr.session_id = {{sessionId::uuid}}' : '';

  const searchQuery = search
    ? `and (session.distinct_id ilike {{search}}
           or (CASE WHEN geo.present THEN geo.city ELSE session.city END) ilike {{search}}
           or env.browser ilike {{search}}
           or env.os ilike {{search}}
           or env.device ilike {{search}})`
    : '';

  const havingQuery = minDurationMs
    ? `having sum(extract(epoch from sr.ended_at - sr.started_at) * 1000) >= {{minDurationMs}}`
    : '';

  return pagedRawQuery(
    `
    select
      sr.visit_id as "id",
      sr.session_id as "sessionId",
      sr.website_id as "websiteId",
      env.browser,
      env.os,
      env.device,
      ${getPostgresCountrySQL('CASE WHEN geo.present THEN geo.country ELSE session.country END')} as country,
      CASE WHEN geo.present THEN geo.city ELSE session.city END as city,
      sum(sr.event_count) as "eventCount",
      count(sr.replay_id) as "chunkCount",
      min(sr.started_at) as "startedAt",
      max(sr.ended_at) as "endedAt",
      sum(extract(epoch from sr.ended_at - sr.started_at) * 1000)::bigint as "duration",
      max(sr.created_at) as "createdAt"
    from session_replay sr
    join session on session.session_id = sr.session_id
      and session.website_id = sr.website_id
    LEFT JOIN LATERAL (
      SELECT true AS present,g.liekan_country AS country,g.liekan_city AS city
      FROM liekan_geographic_website_event g
      WHERE g.website_id=sr.website_id AND g.session_id=sr.session_id AND g.visit_id=sr.visit_id
      ORDER BY g.created_at,g.event_id LIMIT 1
    ) geo ON true
    LEFT JOIN LATERAL (
      SELECT website_event.liekan_browser AS browser,website_event.liekan_os AS os,website_event.liekan_device AS device
      FROM website_event
      ${joinSessionQuery}
      ${cohortQuery}
      WHERE website_event.website_id=sr.website_id AND website_event.session_id=sr.session_id AND website_event.visit_id=sr.visit_id
        AND website_event.created_at BETWEEN {{startDate}} AND {{endDate}}
        ${filterQuery}
      ORDER BY website_event.created_at DESC,website_event.event_id DESC LIMIT 1
    ) env ON true
    ${joinQuery}
    where sr.website_id = {{websiteId::uuid}}
      and sr.created_at between {{startDate}} and {{endDate}}
    ${sessionFilter}
    ${searchQuery}
    group by sr.visit_id,
      sr.session_id,
      sr.website_id,
      env.browser,
      env.os,
      env.device,
      geo.present,geo.country,geo.city,session.country,session.city
    ${havingQuery}
    order by max(sr.created_at) desc
    `,
    { ...queryParams, sessionId, minDurationMs },
    filters,
    FUNCTION_NAME,
  );
}

async function clickhouseQuery(websiteId: string, filters: QueryFilters, sessionId?: string) {
  const { pagedRawQuery, parseFilters } = clickhouse;
  const { search, minDuration } = filters;
  const minDurationMs = minDuration && minDuration > 0 ? minDuration * 1000 : undefined;
  const { queryParams, cohortQuery, filterQuery } = parseFilters({
    ...filters,
    websiteId,
  });

  const sessionFilter = sessionId ? 'and session_replay.session_id = {sessionId:UUID}' : '';

  const searchQuery = search
    ? `and ((positionCaseInsensitive(distinct_id, {search:String}) > 0)
           or (positionCaseInsensitive(city, {search:String}) > 0)
           or (positionCaseInsensitive(browser, {search:String}) > 0)
           or (positionCaseInsensitive(os, {search:String}) > 0)
           or (positionCaseInsensitive(device, {search:String}) > 0))`
    : '';

  const havingQuery = minDurationMs
    ? `having toInt64(sum(toUnixTimestamp64Milli(session_replay.ended_at) - toUnixTimestamp64Milli(session_replay.started_at))) >= {minDurationMs:Int64}`
    : '';

  return pagedRawQuery(
    `
    select
      session_replay.visit_id as id,
      session_replay.session_id as sessionId,
      session_replay.website_id as websiteId,
      website_event.browser,
      website_event.os,
      website_event.device,
      ${getClickHouseCountrySQL('website_event.country')} as country,
      website_event.city,
      sum(session_replay.event_count) as eventCount,
      count(session_replay.replay_id) as chunkCount,
      min(session_replay.started_at) as startedAt,
      max(session_replay.ended_at) as endedAt,
      toInt64(sum(toUnixTimestamp64Milli(session_replay.ended_at) - toUnixTimestamp64Milli(session_replay.started_at))) as duration,
      max(session_replay.created_at) as createdAt
    from session_replay
    join (
      select distinct website_id, session_id, visit_id, browser, os, device, ${getClickHouseCountrySQL('country')} as country, city
      from website_event
      ${cohortQuery}
      where website_id = {websiteId:UUID}
        and created_at between {startDate:DateTime64} and {endDate:DateTime64}
        ${filterQuery}
        ${searchQuery}
    ) website_event
    on website_event.session_id = session_replay.session_id
      and website_event.website_id = session_replay.website_id
      and website_event.visit_id = session_replay.visit_id
    where session_replay.website_id = {websiteId:UUID}
        and session_replay.created_at between {startDate:DateTime64} and {endDate:DateTime64}
    ${sessionFilter}
    group by session_replay.visit_id, session_replay.session_id, session_replay.website_id, website_event.browser, website_event.os, website_event.device, country, website_event.city
    ${havingQuery}
    order by max(created_at) desc
    `,
    { ...queryParams, sessionId, minDurationMs },
    filters,
    FUNCTION_NAME,
  );
}
