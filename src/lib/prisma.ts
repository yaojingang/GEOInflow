import { CacheProbeMiss } from './liekan/upstream/cache-context';
import { identityUsable } from './liekan/contracts/browser-population';
import { readBrowserPopulation, applyNativePopulation } from './liekan/upstream/browser-population';
import { noteBrowserPopulation } from './liekan/upstream/cache-context';
import {
  cityNameSQL,
  cityFilterValues,
  citySearchSQL,
  regionSearchSQL,
} from './liekan/upstream/geography-query';
import { PrismaPg } from '@prisma/adapter-pg';
import { readReplicas } from '@prisma/extension-read-replicas';
import debug from 'debug';
import { PrismaClient, type Prisma } from '@/generated/prisma/client';
import {
  DATA_TYPE,
  DEFAULT_PAGE_SIZE,
  FILTER_COLUMNS,
  OPERATORS,
  SESSION_COLUMNS,
} from './constants';
import {
  getCountryFilterValues,
  getRegionFilterValues,
  getPostgresRegionSQL,
  getPostgresCountrySQL,
} from './country';
import { filtersObjectToArray } from './params';
import type { Operator, PropertyFilter, QueryFilters, QueryOptions } from './types';
import { channelFilterColumn } from './liekan/upstream/filter-extension';
import { privateAiQueryLog } from './liekan/upstream/ai-query-logging';
import { getQuerySnapshot } from './liekan/upstream/query-snapshot';
import { analyticsCache, analyticsCacheKey, websiteCacheTag } from './liekan/upstream/query-cache';
import {
  cacheHeadersEnabled,
  noteCacheResult,
  currentCacheContext,
} from './liekan/upstream/cache-context';
import { statisticsCacheTtl } from './liekan/upstream/cache-policy';
import { installAnalyticsRuntime } from './liekan/upstream/analytics-runtime';
import { isAnalyticsWorker } from './liekan/upstream/process-role';
import { primaryMetadataClient } from './liekan/upstream/analytics-deadline';
import { currentCollectionTransaction } from './liekan/upstream/collection-write';

const log = debug('umami:prisma');

const EQUALITY_OPERATORS: Operator[] = [OPERATORS.equals, OPERATORS.notEquals];
const SEARCH_OPERATORS: Operator[] = [OPERATORS.contains, OPERATORS.doesNotContain];
const REGEX_OPERATORS: Operator[] = [OPERATORS.regex, OPERATORS.notRegex];

const PRISMA = 'prisma';

const PRISMA_LOG_OPTIONS = {
  log: [
    {
      emit: 'event' as const,
      level: 'query' as const,
    },
  ],
};

export interface RawQueryExecutor {
  $executeRawUnsafe: (query: string, ...params: any[]) => unknown;
  $queryRawUnsafe: (query: string, ...params: any[]) => unknown;
}

export interface RawQueryClient extends RawQueryExecutor {
  $primary?: () => unknown;
  $replica?: () => unknown;
}

function isRawQueryExecutor(value: unknown): value is RawQueryExecutor {
  return (
    !!value &&
    typeof value === 'object' &&
    '$executeRawUnsafe' in value &&
    '$queryRawUnsafe' in value
  );
}

export function getRawQueryClient(
  client: RawQueryClient,
  {
    useReplica = false,
    write = false,
  }: {
    useReplica?: boolean;
    write?: boolean;
  } = {},
) {
  const metadata = primaryMetadataClient();
  if (metadata) return metadata as RawQueryClient;
  if (write) {
    const primary = typeof client.$primary === 'function' ? client.$primary() : null;
    return isRawQueryExecutor(primary) ? primary : client;
  }

  if (useReplica && typeof client.$replica === 'function') {
    const replica = client.$replica();

    if (isRawQueryExecutor(replica)) {
      return replica;
    }
  }

  return client;
}

// Always Z-suffixed so JS parses the already-shifted local value as an unambiguous
// instant instead of re-interpreting it in the runtime's own timezone.
const DATE_FORMATS = {
  minute: 'YYYY-MM-DD"T"HH24:MI:00"Z"',
  hour: 'YYYY-MM-DD"T"HH24:00:00"Z"',
  day: 'YYYY-MM-DD"T"HH24:00:00"Z"',
  month: 'YYYY-MM-01"T"HH24:00:00"Z"',
  year: 'YYYY-01-01"T"HH24:00:00"Z"',
};

const DATE_STRING_FORMATS = {
  utc: 'YYYY-MM-DD"T"HH24:MI:SS"Z"',
  second: 'YYYY-MM-DD"T"HH24:MI:SS"Z"',
};

function isUtcTimezone(timezone?: string) {
  return timezone?.toLowerCase() === 'utc';
}

function getAddIntervalQuery(field: string, interval: string): string {
  return `${field} + interval '${interval}'`;
}

function getDayDiffQuery(field1: string, field2: string): string {
  return `${field1}::date - ${field2}::date`;
}

function getCastColumnQuery(field: string, type: string): string {
  return `${field}::${type}`;
}

function getDateSQL(field: string, unit: string, timezone?: string): string {
  // Explicit `at time zone` even for UTC — `date_trunc` without one falls back to the
  // DB session's ambient TimeZone setting, which this app never pins.
  const tz = timezone && !isUtcTimezone(timezone) ? timezone : 'UTC';

  return `to_char(date_trunc('${unit}', ${field} at time zone '${tz}'), '${DATE_FORMATS[unit]}')`;
}

function getDateStringSQL(
  field: string,
  unit: keyof typeof DATE_STRING_FORMATS = 'utc',
  timezone?: string,
): string {
  const isUtc = !timezone || isUtcTimezone(timezone);
  const tz = isUtc ? 'UTC' : timezone;
  const format = isUtc ? DATE_STRING_FORMATS.utc : DATE_STRING_FORMATS[unit];

  return `to_char(${field} at time zone '${tz}', '${format}')`;
}

function getDateWeeklySQL(field: string, timezone?: string) {
  const tz = timezone && !isUtcTimezone(timezone) ? timezone : 'UTC';

  return `concat(extract(dow from (${field} at time zone '${tz}')), ':', to_char((${field} at time zone '${tz}'), 'HH24'))`;
}

export function getTimestampSQL(field: string) {
  return `floor(extract(epoch from ${field}))`;
}

function getTimestampDiffSQL(field1: string, field2: string): string {
  return `floor(extract(epoch from (${field2} - ${field1})))`;
}

function getSearchSQL(column: string, param: string = 'search'): string {
  return `and ${column} ilike {{${param}}}`;
}

function mapFilter(
  column: string,
  operator: string,
  name: string,
  type: string = '',
  paramName?: string,
  expression = false,
  filterValue?: unknown,
) {
  const param = paramName ?? name;
  const value = `{{${param}${type ? `::${type}` : ''}}}`;

  if (name.startsWith('cohort_')) {
    name = name.slice('cohort_'.length);
  }
  name = name.replace(/^drill_/, '');

  const table = SESSION_COLUMNS.includes(name) ? 'session' : 'website_event';
  const rawColumn = expression ? column : `${table}.${column}`;
  const qualified =
    name === 'region'
      ? getPostgresRegionSQL(rawColumn.replace(/region$/, 'country'), rawColumn)
      : name === 'country'
        ? getPostgresCountrySQL(rawColumn)
        : name === 'city'
          ? cityNameSQL(
              rawColumn.replace(/city$/, 'country'),
              rawColumn.replace(/city$/, 'region'),
              rawColumn,
              'postgres',
              filterValue,
            )
          : rawColumn;
  if (name === 'region' && ['c', 'dnc', 're', 'nre'].includes(operator))
    return regionSearchSQL(
      rawColumn.replace(/region$/, 'country'),
      rawColumn,
      'postgres',
      operator,
      value,
    );
  if (name === 'city' && ['c', 'dnc', 're', 'nre'].includes(operator))
    return citySearchSQL(
      rawColumn.replace(/city$/, 'country'),
      rawColumn.replace(/city$/, 'region'),
      rawColumn,
      'postgres',
      operator,
      value,
    );
  const searchGeography = (comparison: string, join: 'or' | 'and') =>
    name === 'region' || name === 'country' || name === 'city'
      ? `(${qualified} ${comparison} ${join} coalesce(${rawColumn}, ${qualified}) ${comparison})`
      : `${qualified} ${comparison}`;

  switch (operator) {
    case OPERATORS.equals:
      return name === 'city'
        ? searchGeography(`= ANY(${value})`, 'or')
        : `${qualified} = ANY(${value})`;
    case OPERATORS.notEquals:
      return name === 'city'
        ? searchGeography(`!= ALL(${value})`, 'and')
        : `${qualified} != ALL(${value})`;
    case OPERATORS.contains:
      return searchGeography(`ilike ${value}`, 'or');
    case OPERATORS.doesNotContain:
      return searchGeography(`not ilike ${value}`, 'and');
    case OPERATORS.regex:
      return searchGeography(`~* ${value}`, 'or');
    case OPERATORS.notRegex:
      return searchGeography(`!~* ${value}`, 'and');
    default:
      return '';
  }
}

function getFilterQuery(filters: Record<string, any>, options: QueryOptions = {}): string {
  const { isCohort, cohortMatch, cohortActionName } = options;
  const isOr = isCohort ? cohortMatch === 'any' : filters.match === 'any';
  const orClauses: string[] = [];
  const andClauses: string[] = [];

  filtersObjectToArray(filters, options).forEach(
    ({ name, column, operator, prefix = '', paramName, value }) => {
      if (isCohort) {
        column = FILTER_COLUMNS[name.slice('cohort_'.length)];
      }

      if (column) {
        const resolved =
          column === 'liekan_channel'
            ? channelFilterColumn(prefix || 'website_event.')
            : `${prefix}${column}`;
        if (name.startsWith('drill_') && filters[paramName ?? name] === 'empty.') {
          const table = SESSION_COLUMNS.includes(name.replace(/^drill_/, ''))
            ? 'session'
            : 'website_event';
          const rawColumn = column === 'liekan_channel' ? resolved : `${table}.${resolved}`;
          const qualified =
            column === 'region'
              ? getPostgresRegionSQL(rawColumn.replace(/region$/, 'country'), rawColumn)
              : rawColumn;
          andClauses.push(`and (${qualified} is null or ${qualified} = '')`);
          return;
        }
        const clause = mapFilter(
          resolved,
          operator,
          name,
          '',
          paramName,
          column === 'liekan_channel',
          value,
        );
        const isAlwaysAnd =
          name === 'eventType' ||
          name.startsWith('drill_') ||
          (isCohort && name === cohortActionName);

        if (isAlwaysAnd) {
          andClauses.push(`and ${clause}`);
        } else if (isOr) {
          orClauses.push(clause);
        } else {
          andClauses.push(`and ${clause}`);
        }

        if (name === 'referrer') {
          andClauses.push(
            `and (website_event.referrer_domain != regexp_replace(website_event.hostname, '^www.', '') or website_event.referrer_domain is null)`,
          );
        }
      }
    },
  );

  const parts: string[] = [];

  if (orClauses.length > 0) {
    parts.push(`and (\n  ${orClauses.join('\n  or ')}\n)`);
  }

  parts.push(...andClauses);

  return parts.join('\n');
}

function getCohortQuery(filters: QueryFilters = {}) {
  if (!filters || Object.keys(filters).length === 0) {
    return '';
  }

  const cohortMatch = (filters as any).cohort_match;
  const cohortActionName = (filters as any).cohort_actionName;

  const filterQuery = getFilterQuery(filters, { isCohort: true, cohortMatch, cohortActionName });

  return `join
    (select distinct website_event.session_id
    from website_event
    join session on session.session_id = website_event.session_id
      and session.website_id = website_event.website_id
    where website_event.website_id = {{websiteId}}
      and website_event.created_at between {{cohort_startDate}} and {{cohort_endDate}}
      ${filterQuery}
    ) cohort
    on cohort.session_id = website_event.session_id
    `;
}

function getExcludeBounceQuery(filters: Record<string, any>) {
  if (filters.excludeBounce !== true) {
    return '';
  }

  return `join
    (select session_id, visit_id
    from website_event
    where website_id = {{websiteId}}
      and created_at between {{startDate}} and {{endDate}}
      and event_type != 5
    group by session_id, visit_id
    having sum(case when event_type NOT IN (2, 5) then 1 else 0 end) > 1
      or (
        sum(case when event_type NOT IN (2, 5) then 1 else 0 end) = 1
        and sum(case when event_type = 2 then 1 else 0 end) > 0
      )
    ) excludeBounce
    on excludeBounce.session_id = website_event.session_id
      and excludeBounce.visit_id = website_event.visit_id
    `;
}

function getDateQuery(filters: Record<string, any>) {
  const { startDate, endDate } = filters;

  if (startDate) {
    if (endDate) {
      return `and website_event.created_at between {{startDate}} and {{endDate}}`;
    } else {
      return `and website_event.created_at >= {{startDate}}`;
    }
  }

  return '';
}

function getQueryParams(filters: Record<string, any>) {
  return {
    ...filters,
    ...filtersObjectToArray(filters).reduce((obj, { name, column, operator, value, paramName }) => {
      const resolvedColumn =
        column || (name?.startsWith('cohort_') && FILTER_COLUMNS[name.slice('cohort_'.length)]);

      if (!resolvedColumn) return obj;

      const key = paramName ?? name;
      const filterName = (
        name?.startsWith('cohort_') ? name.slice('cohort_'.length) : name
      )?.replace(/^drill_/, '');

      if (SEARCH_OPERATORS.includes(operator)) {
        obj[key] = `%${value}%`;
      } else if (EQUALITY_OPERATORS.includes(operator)) {
        obj[key] =
          filterName === 'country'
            ? getCountryFilterValues(value)
            : filterName === 'region'
              ? getRegionFilterValues(value)
              : filterName === 'city'
                ? [
                    ...new Set([
                      ...cityFilterValues(value),
                      ...(Array.isArray(value) ? value : [value]),
                    ]),
                  ]
                : Array.isArray(value)
                  ? value
                  : [value];
      } else {
        obj[key] = value;
      }

      return obj;
    }, {}),
  };
}

function parseFilters(filters: Record<string, any>, options?: QueryOptions) {
  const joinSession = Object.keys(filters).find(key => {
    const baseName = key.replace(/\d+$/, '').replace(/^drill_/, '');
    return ['referrer', ...SESSION_COLUMNS].includes(baseName);
  });

  const cohortFilters = Object.fromEntries(
    Object.entries(filters).filter(([key]) => key.startsWith('cohort_')),
  );
  const { sql: eventPropertyFilterQuery, params: eventPropertyFilterParams } =
    getEventPropertyFilterQuery((filters as QueryFilters).eventPropertyFilters, filters.timezone);
  const { sql: sessionPropertyFilterQuery, params: sessionPropertyFilterParams } =
    getSessionPropertyFilterQuery(
      (filters as QueryFilters).sessionPropertyFilters,
      filters.timezone,
    );

  return {
    joinSessionQuery:
      options?.joinSession || joinSession
        ? `inner join session on website_event.session_id = session.session_id and website_event.website_id = session.website_id`
        : '',
    dateQuery: getDateQuery(filters),
    filterQuery: [
      getFilterQuery(filters, options),
      eventPropertyFilterQuery,
      sessionPropertyFilterQuery,
    ]
      .filter(Boolean)
      .join('\n'),
    queryParams: {
      ...getQueryParams(filters),
      ...eventPropertyFilterParams,
      ...sessionPropertyFilterParams,
    },
    cohortQuery: getCohortQuery(cohortFilters),
    excludeBounceQuery: getExcludeBounceQuery(filters),
  };
}

function getPropertyFilterQuery(
  filters: PropertyFilter[] = [],
  propertyType: 'event' | 'session' = 'event',
  timezone?: string,
): {
  sql: string;
  params: Record<string, any>;
} {
  if (!filters.length) return { sql: '', params: {} };

  const parts: string[] = [];
  const params: Record<string, any> = {};
  const table = propertyType === 'event' ? 'event_data' : 'session_data';
  const column = propertyType === 'event' ? 'website_event_id' : 'session_id';
  const outerColumn =
    propertyType === 'event' ? 'website_event.event_id' : 'website_event.session_id';
  const dateFilter =
    propertyType === 'event' ? `and created_at between {{startDate}} and {{endDate}}` : '';

  filters.forEach(({ propertyName, dataType, operator, value }, i) => {
    const keyParam = `pf_key_${i}`;
    const valParam = `pf_val_${i}`;
    params[keyParam] = propertyName;

    let condition: string;
    switch (dataType) {
      case DATA_TYPE.number: {
        const col = 'cast(number_value as decimal)';
        params[valParam] = parseFloat(value) || 0;
        const opMap: Record<string, string> = {
          [OPERATORS.equals]: `${col} = {{${valParam}}}`,
          [OPERATORS.notEquals]: `${col} != {{${valParam}}}`,
          [OPERATORS.greaterThan]: `${col} > {{${valParam}}}`,
          [OPERATORS.lessThan]: `${col} < {{${valParam}}}`,
          [OPERATORS.greaterThanEquals]: `${col} >= {{${valParam}}}`,
          [OPERATORS.lessThanEquals]: `${col} <= {{${valParam}}}`,
        };
        condition = opMap[operator] ?? `${col} = {{${valParam}}}`;
        break;
      }
      case DATA_TYPE.date: {
        if (!value) return;
        params[valParam] = value;
        const dateCol =
          timezone && !isUtcTimezone(timezone)
            ? `(date_value at time zone {{timezone}})::date`
            : `(date_value at time zone 'utc')::date`;
        const opMap: Record<string, string> = {
          [OPERATORS.before]: `${dateCol} < {{${valParam}::date}}`,
          [OPERATORS.after]: `${dateCol} > {{${valParam}::date}}`,
        };
        condition = opMap[operator] ?? `${dateCol} = {{${valParam}::date}}`;
        break;
      }
      case DATA_TYPE.array: {
        if (!value) return;
        params[valParam] = value;
        condition =
          operator === OPERATORS.contains
            ? `exists (
                select 1
                from jsonb_array_elements_text(coalesce(string_value, '[]')::jsonb) as array_item(value)
                where array_item.value = {{${valParam}}}
              )`
            : `not exists (
                select 1
                from jsonb_array_elements_text(coalesce(string_value, '[]')::jsonb) as array_item(value)
                where array_item.value = {{${valParam}}}
              )`;
        break;
      }
      default: {
        const col = 'string_value';

        if (EQUALITY_OPERATORS.includes(operator)) {
          const vals = value.split(',').filter(Boolean);
          if (!vals.length) return;
          params[valParam] = vals;
          condition =
            operator === OPERATORS.equals
              ? `${col} = ANY({{${valParam}}})`
              : `${col} != ALL({{${valParam}}})`;
        } else if (REGEX_OPERATORS.includes(operator)) {
          if (!value) return;
          params[valParam] = value;
          condition =
            operator === OPERATORS.regex
              ? `${col} ~* {{${valParam}}}`
              : `${col} !~* {{${valParam}}}`;
        } else {
          if (!value) return;
          params[valParam] = `%${value}%`;
          condition =
            operator === OPERATORS.contains
              ? `${col} ilike {{${valParam}}}`
              : `${col} not ilike {{${valParam}}}`;
        }
        break;
      }
    }

    if (propertyType === 'session') {
      parts.push(`and exists (
      select 1
      from ${table}
      where website_id = website_event.website_id
        and session_id = website_event.session_id
        and data_key = {{${keyParam}}}
        and data_type = ${dataType}
        and ${condition}
    )`);
    } else {
      parts.push(`and ${outerColumn} in (
      select ${column}
      from ${table}
      where website_id = {{websiteId::uuid}}
        ${dateFilter}
        and data_key = {{${keyParam}}}
        and data_type = ${dataType}
        and ${condition}
    )`);
    }
  });

  return { sql: parts.join('\n'), params };
}

function getEventPropertyFilterQuery(
  filters: PropertyFilter[] = [],
  timezone?: string,
): {
  sql: string;
  params: Record<string, any>;
} {
  if (!filters.length) {
    return { sql: '', params: {} };
  }

  const clauses: string[] = [];
  const keyRefs: string[] = [];
  const params: Record<string, any> = {};

  filters.forEach(({ propertyName, dataType, operator, value }, index) => {
    const keyParam = `epf_key_${index}`;
    const valParam = `epf_val_${index}`;
    params[keyParam] = propertyName;
    keyRefs.push(`{{${keyParam}}}`);

    let condition: string;

    switch (dataType) {
      case DATA_TYPE.number: {
        const col = 'cast(number_value as decimal)';
        params[valParam] = parseFloat(value) || 0;
        const opMap: Record<string, string> = {
          [OPERATORS.equals]: `${col} = {{${valParam}}}`,
          [OPERATORS.notEquals]: `${col} != {{${valParam}}}`,
          [OPERATORS.greaterThan]: `${col} > {{${valParam}}}`,
          [OPERATORS.lessThan]: `${col} < {{${valParam}}}`,
          [OPERATORS.greaterThanEquals]: `${col} >= {{${valParam}}}`,
          [OPERATORS.lessThanEquals]: `${col} <= {{${valParam}}}`,
        };
        condition = opMap[operator] ?? `${col} = {{${valParam}}}`;
        break;
      }
      case DATA_TYPE.date: {
        if (!value) return;
        params[valParam] = value;
        const dateCol =
          timezone && !isUtcTimezone(timezone)
            ? `(date_value at time zone {{timezone}})::date`
            : `(date_value at time zone 'utc')::date`;
        const opMap: Record<string, string> = {
          [OPERATORS.before]: `${dateCol} < {{${valParam}::date}}`,
          [OPERATORS.after]: `${dateCol} > {{${valParam}::date}}`,
        };
        condition = opMap[operator] ?? `${dateCol} = {{${valParam}::date}}`;
        break;
      }
      case DATA_TYPE.array: {
        if (!value) return;
        params[valParam] = value;
        condition =
          operator === OPERATORS.contains
            ? `exists (
                select 1
                from jsonb_array_elements_text(coalesce(string_value, '[]')::jsonb) as array_item(value)
                where array_item.value = {{${valParam}}}
              )`
            : `not exists (
                select 1
                from jsonb_array_elements_text(coalesce(string_value, '[]')::jsonb) as array_item(value)
                where array_item.value = {{${valParam}}}
              )`;
        break;
      }
      default: {
        const col = 'string_value';

        if (EQUALITY_OPERATORS.includes(operator)) {
          const vals = value.split(',').filter(Boolean);

          if (!vals.length) return;

          params[valParam] = vals;
          condition =
            operator === OPERATORS.equals
              ? `${col} = ANY({{${valParam}}})`
              : `${col} != ALL({{${valParam}}})`;
        } else if (REGEX_OPERATORS.includes(operator)) {
          if (!value) return;

          params[valParam] = value;
          condition =
            operator === OPERATORS.regex
              ? `${col} ~* {{${valParam}}}`
              : `${col} !~* {{${valParam}}}`;
        } else {
          if (!value) return;

          params[valParam] = `%${value}%`;
          condition =
            operator === OPERATORS.contains
              ? `${col} ilike {{${valParam}}}`
              : `${col} not ilike {{${valParam}}}`;
        }
        break;
      }
    }

    clauses.push(
      `bool_or(data_key = {{${keyParam}}} and data_type = ${dataType} and ${condition})`,
    );
  });

  if (!clauses.length) {
    return { sql: '', params: {} };
  }

  return {
    sql: `and website_event.event_id in (
      select website_event_id
      from event_data
      where website_id = {{websiteId::uuid}}
        and created_at between {{startDate}} and {{endDate}}
        and data_key in (${keyRefs.join(', ')})
      group by website_event_id
      having ${clauses.join('\n        and ')}
    )`,
    params,
  };
}

function getSessionPropertyFilterQuery(
  filters: PropertyFilter[] = [],
  timezone?: string,
): {
  sql: string;
  params: Record<string, any>;
} {
  if (!filters.length) {
    return { sql: '', params: {} };
  }

  const clauses: string[] = [];
  const keyRefs: string[] = [];
  const params: Record<string, any> = {};

  filters.forEach(({ propertyName, dataType, operator, value }, index) => {
    const keyParam = `spf_key_${index}`;
    const valParam = `spf_val_${index}`;
    params[keyParam] = propertyName;
    keyRefs.push(`{{${keyParam}}}`);

    let condition: string;

    switch (dataType) {
      case DATA_TYPE.number: {
        const col = 'cast(number_value as decimal)';
        params[valParam] = parseFloat(value) || 0;
        const opMap: Record<string, string> = {
          [OPERATORS.equals]: `${col} = {{${valParam}}}`,
          [OPERATORS.notEquals]: `${col} != {{${valParam}}}`,
          [OPERATORS.greaterThan]: `${col} > {{${valParam}}}`,
          [OPERATORS.lessThan]: `${col} < {{${valParam}}}`,
          [OPERATORS.greaterThanEquals]: `${col} >= {{${valParam}}}`,
          [OPERATORS.lessThanEquals]: `${col} <= {{${valParam}}}`,
        };
        condition = opMap[operator] ?? `${col} = {{${valParam}}}`;
        break;
      }
      case DATA_TYPE.date: {
        if (!value) return;
        params[valParam] = value;
        const dateCol =
          timezone && !isUtcTimezone(timezone)
            ? `(date_value at time zone {{timezone}})::date`
            : `(date_value at time zone 'utc')::date`;
        const opMap: Record<string, string> = {
          [OPERATORS.before]: `${dateCol} < {{${valParam}::date}}`,
          [OPERATORS.after]: `${dateCol} > {{${valParam}::date}}`,
        };
        condition = opMap[operator] ?? `${dateCol} = {{${valParam}::date}}`;
        break;
      }
      case DATA_TYPE.array: {
        if (!value) return;
        params[valParam] = value;
        condition =
          operator === OPERATORS.contains
            ? `exists (
                select 1
                from jsonb_array_elements_text(coalesce(string_value, '[]')::jsonb) as array_item(value)
                where array_item.value = {{${valParam}}}
              )`
            : `not exists (
                select 1
                from jsonb_array_elements_text(coalesce(string_value, '[]')::jsonb) as array_item(value)
                where array_item.value = {{${valParam}}}
              )`;
        break;
      }
      default: {
        const col = 'string_value';

        if (EQUALITY_OPERATORS.includes(operator)) {
          const vals = value.split(',').filter(Boolean);

          if (!vals.length) return;

          params[valParam] = vals;
          condition =
            operator === OPERATORS.equals
              ? `${col} = ANY({{${valParam}}})`
              : `${col} != ALL({{${valParam}}})`;
        } else if (REGEX_OPERATORS.includes(operator)) {
          if (!value) return;

          params[valParam] = value;
          condition =
            operator === OPERATORS.regex
              ? `${col} ~* {{${valParam}}}`
              : `${col} !~* {{${valParam}}}`;
        } else {
          if (!value) return;

          params[valParam] = `%${value}%`;
          condition =
            operator === OPERATORS.contains
              ? `${col} ilike {{${valParam}}}`
              : `${col} not ilike {{${valParam}}}`;
        }
        break;
      }
    }

    clauses.push(
      `bool_or(data_key = {{${keyParam}}} and data_type = ${dataType} and ${condition})`,
    );
  });

  if (!clauses.length) {
    return { sql: '', params: {} };
  }

  return {
    sql: `and exists (
      select 1
      from session_data
      where website_id = website_event.website_id
        and session_id = website_event.session_id
        and data_key in (${keyRefs.join(', ')})
      group by website_id, session_id
      having ${clauses.join('\n        and ')}
    )`,
    params,
  };
}

async function executeRawQuery(
  sql: string,
  data: Record<string, any>,
  name?: string,
  write = false,
): Promise<any> {
  if (process.env.LOG_QUERY && !getQuerySnapshot()?.aiPrivate) {
    log('QUERY:\n', sql);
    log('PARAMETERS:\n', data);
    log('NAME:\n', name);
  }
  const params = [];
  const bindings = new Map<string, string>();
  const schema = getSchema();

  const query = sql?.replaceAll(/\{\{\s*(\w+)(::\w+)?\s*}}/g, (...args) => {
    const [, name, type] = args;

    const value = data[name];

    params.push(value);

    const reference = `$${params.length}${type ?? ''}`;
    if (!bindings.has(name)) bindings.set(name, reference);
    return reference;
  });

  const queryClient =
    (write && currentCollectionTransaction()) ||
    (!write && getQuerySnapshot()) ||
    getRawQueryClient(client, {
      // Website analytics read repair pointers and facts from the same primary database.
      useReplica: !!process.env.DATABASE_REPLICA_URL && !data.websiteId && !data.websiteIds,
      write: write || !!data.websiteId || !!data.websiteIds,
    });

  if (schema) {
    await queryClient.$executeRawUnsafe(`SET search_path TO "${schema}";`);
  }

  return queryClient.$queryRawUnsafe(
    write ? query : withTrafficPolicy(query, propertyWindowForQuery(name, bindings)),
    ...params,
  );
}

async function rawQuery(sql: string, data: Record<string, any>, name?: string): Promise<any> {
  const cacheable = new Set([
    'getWebsiteStats',
    'getChannelMetrics',
    'getChannelExpandedMetrics',
    'getPageviewStats',
    'getPageviewMetrics',
    'getPageviewExpandedMetrics',
    'getEventStats',
    'getEventMetrics',
    'getWebsiteEventStats',
    'getEventExpandedMetrics',
    'getGoal',
    'getFunnel',
    'getRetention',
    'getJourney',
    'getBreakdown',
    'getPerformanceStats',
    'getPerformanceChart',
    'getPerformanceMetrics',
    'getRevenueStats',
    'getRevenueChart',
    'getRevenueMetrics',
    'getUTM',
    'getWebsiteListCharts',
    'getHeatmap',
    'liekanFeatureGoal',
    'liekanLinkSourcesCount',
    'liekanLinkSourcesRows',
    'liekanRevenueCount',
    'getSessionStats',
    'getSessionMetrics',
    'getSessionExpandedMetrics',
  ]);
  const populationQuery =
    !!(data.websiteId || data.websiteIds?.length) &&
    !!data.startDate &&
    !!data.endDate &&
    /\b(?:website_event|website_event_stats_hourly|heatmap_event)\b/.test(sql);
  const load = async () => {
    const rows = await executeRawQuery(sql, data, name);
    const populations = populationQuery
      ? await Promise.all(
          (data.websiteId ? [data.websiteId] : data.websiteIds).map(async (id: string) => ({
            id,
            population: await readBrowserPopulation(
              id,
              new Date(data.startDate),
              new Date(data.endDate),
              data.timezone || (currentCacheContext()?.parameters?.timezone as string) || 'UTC',
            ),
          })),
        )
      : [];
    return {
      rows: rows.map(row => {
        const population = populations.find(
          item => item.id === (data.websiteId || row.websiteId),
        )?.population;
        return population ? applyNativePopulation([row], name, population)[0] : row;
      }),
      populations,
    };
  };
  const unwrap = (result: Awaited<ReturnType<typeof load>>) => {
    for (const { id, population } of result.populations) noteBrowserPopulation(id, population);
    return result.rows;
  };
  const ids = data.websiteId ? [data.websiteId] : data.websiteIds;
  const cacheTimezone = data.timezone || currentCacheContext()?.parameters?.timezone;
  if (ids?.length && cacheable.has(name) && !getQuerySnapshot() && cacheHeadersEnabled()) {
    const cacheBindings = Object.fromEntries(
      [...sql.matchAll(/\{\{\s*(\w+)(?:::\w+)?\s*}}/g)].map(match => [match[1], data[match[1]]]),
    );
    const inputKey = analyticsCacheKey(`native-statistics-${TRAFFIC_POLICY_VERSION}`, [
      process.env.DATABASE_URL,
      process.env.DATABASE_REPLICA_URL,
      sql,
      cacheBindings,
      cacheTimezone,
    ]);
    const result = await analyticsCache.read(
      inputKey,
      data.endDate ? statisticsCacheTtl(data.endDate, cacheTimezone) : 30000,
      ids.map(websiteCacheTag),
      () => (populationQuery ? nativeSnapshot(load) : load()),
    );
    noteCacheResult(result);
    return unwrap(result.value);
  }
  if (currentCacheContext()?.probeOnly) throw new CacheProbeMiss();
  return unwrap(await (populationQuery ? nativeSnapshot(load) : load()));
}

async function writeRawQuery(sql: string, data: Record<string, any>, name?: string): Promise<any> {
  return executeRawQuery(sql, data, name, true);
}

async function pagedQuery<T>(model: string, criteria: T, filters?: QueryFilters) {
  const { page = 1, pageSize, orderBy, sortDescending = false, search } = filters || {};
  const size = +pageSize || DEFAULT_PAGE_SIZE;

  const data = await client[model].findMany({
    ...criteria,
    ...{
      ...(size > 0 && { take: +size, skip: +size * (+page - 1) }),
      ...(orderBy && {
        orderBy: [
          {
            [orderBy]: sortDescending ? 'desc' : 'asc',
          },
        ],
      }),
    },
  });

  const count = await client[model].count({ where: (criteria as any).where });

  return { data, count, page: +page, pageSize: size, orderBy, search };
}

async function pagedRawQuery(
  query: string,
  queryParams: Record<string, any>,
  filters: QueryFilters,
  name?: string,
  defaultOrderBy?: string,
) {
  const { page = 1, pageSize, orderBy, sortDescending = false } = filters;
  const size = +pageSize || DEFAULT_PAGE_SIZE;
  const offset = +size * (+page - 1);
  const direction = sortDescending ? 'desc' : 'asc';

  const statements = [
    orderBy ? `order by ${orderBy} ${direction}` : defaultOrderBy && `order by ${defaultOrderBy}`,
    +size > 0 && `limit ${+size} offset ${offset}`,
  ]
    .filter(n => n)
    .join('\n');

  const { maxResults } = filters;
  const countQuery = maxResults
    ? `select count(*) as num from (select 1 from (${query}) t limit ${+maxResults}) t2`
    : `select count(*) as num from (${query}) t`;

  const load = async () => {
    const count = await rawQuery(
      countQuery,
      queryParams,
      name === 'getEventDataPivot' ? name : undefined,
    ).then(res => Number(res[0].num));
    const data = await rawQuery(`${query}${statements}`, queryParams, name);
    const population =
      queryParams.websiteId && queryParams.startDate && queryParams.endDate
        ? await readBrowserPopulation(
            queryParams.websiteId,
            new Date(queryParams.startDate),
            new Date(queryParams.endDate),
            queryParams.timezone || 'UTC',
          )
        : undefined;
    if (
      [
        'getWebsiteSessions',
        'getSessionDataPivot',
        'getRevenueSessions',
        'getSessionReplays',
      ].includes(name) &&
      !identityUsable(population)
    )
      return {
        data: [],
        count: null,
        page: +page,
        pageSize: size,
        orderBy,
        isCapped: false,
        population,
      };
    return {
      ...(population ? { population } : {}),
      data,
      count,
      page: +page,
      pageSize: size,
      orderBy,
      isCapped: !!maxResults && +count >= +maxResults,
    };
  };
  return queryParams.websiteId ? nativeSnapshot(load) : load();
}

function getSearchParameters(query: string, filters: Record<string, any>[]) {
  if (!query) return;

  const parseFilter = (filter: Record<string, any>) => {
    const [[key, value]] = Object.entries(filter);

    return {
      [key]:
        typeof value === 'string'
          ? {
              [value]: query,
              mode: 'insensitive',
            }
          : parseFilter(value),
    };
  };

  const params = filters.map(filter => parseFilter(filter));

  return {
    AND: {
      OR: params,
    },
  };
}

function transaction<T>(input: (tx: any) => Promise<T>, options?: any): Promise<T>;
function transaction(input: any[], options?: any): Promise<any[]>;
function transaction(input: any, options?: any): any {
  return (getRawQueryClient(client, { write: true }) as typeof client).$transaction(input, options);
}

export function getSchema() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set.');
  }

  const connectionUrl = new URL(databaseUrl);

  return connectionUrl.searchParams.get('schema');
}

function getClient() {
  const url = process.env.DATABASE_URL;
  const replicaUrl = process.env.DATABASE_REPLICA_URL;
  const logQuery = process.env.LOG_QUERY;

  if (!url) {
    throw new Error('DATABASE_URL is not set.');
  }

  const schema = getSchema();

  const baseAdapter = new PrismaPg(
    // Two foreground computations and one background computation retain one control connection.
    { connectionString: url, ...(isAnalyticsWorker() ? { max: 4 } : {}) },
    { schema },
  );

  const baseClient = new PrismaClient({
    adapter: baseAdapter,
    errorFormat: 'pretty',
    ...(logQuery ? PRISMA_LOG_OPTIONS : {}),
  });

  if (logQuery) {
    baseClient.$on('query', event => log(privateAiQueryLog(event)));
  }

  if (!replicaUrl) {
    log('Prisma initialized');
    globalThis[PRISMA] ??= baseClient;
    return baseClient;
  }

  const replicaAdapter = new PrismaPg({ connectionString: replicaUrl }, { schema });

  const replicaClient = new PrismaClient({
    adapter: replicaAdapter,
    errorFormat: 'pretty',
    ...(logQuery ? PRISMA_LOG_OPTIONS : {}),
  });

  if (logQuery) {
    replicaClient.$on('query', event => log(privateAiQueryLog(event)));
  }

  const extended = baseClient.$extends(
    readReplicas({
      replicas: [replicaClient],
    }),
  );

  log('Prisma initialized (with replica)');
  globalThis[PRISMA] ??= extended;

  return extended;
}

const client = (globalThis[PRISMA] || getClient()) as ReturnType<typeof getClient>;
installAnalyticsRuntime(analyticsCache, () => getRawQueryClient(client, { write: true }));

export default {
  client,
  transaction,
  getAddIntervalQuery,
  getCastColumnQuery,
  getDayDiffQuery,
  getDateSQL,
  getDateStringSQL,
  getDateWeeklySQL,
  getFilterQuery,
  getPropertyFilterQuery,
  getSearchParameters,
  getTimestampDiffSQL,
  getSearchSQL,
  pagedQuery,
  pagedRawQuery,
  parseFilters,
  rawQuery,
  writeRawQuery,
};
import {
  TRAFFIC_POLICY_VERSION,
  withTrafficPolicy,
  propertyWindowForQuery,
} from './liekan/upstream/traffic-query';
import { nativeSnapshot } from './liekan/upstream/native-snapshot';
