import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Decimal } from '@prisma/client/runtime/client';
import {
  nativeCacheMatrix,
  supplementalCacheMatrix,
  type CacheMatrixEntry,
} from './liekan-cache-matrix';

import { ANALYSIS_ROLLUP_VERSION } from '../src/lib/liekan/upstream/analysis-rollups-model';
import { TRAFFIC_POLICY_VERSION } from '../src/lib/liekan/upstream/traffic-query';
import { CRAWLER_POPULATION_VERSION } from '../src/lib/liekan/rules/population';

const rollupVersionsSql =
  'SELECT liekan_analysis_versions($1::uuid,$2::text,$3::text,$4::text) AS versions';
const metadataTags = new Set([
  ANALYSIS_ROLLUP_VERSION,
  TRAFFIC_POLICY_VERSION,
  CRAWLER_POPULATION_VERSION,
  'log',
  'visit',
  'all',
  'UTC',
]);

/**
 * Actual execution plans for the disposable cache benchmark. Importing performs no SQL.
 * Call only after every timed scenario and browser/old-image measurement finishes,
 * before the benchmark removes its own database. A restored, quiet synthetic copy
 * can also be used. Actual function reads and their EXPLAINs use separate snapshots.
 * This requires a fresh process that has not initialized src/lib/prisma previously.
 * Run from the repository root with its installed tsx and Node 22.
 *
 * Integration in scripts/liekan-cache-benchmark.ts, after all timed scenarios:
 *   const { collectHeavyExplains } = await import('./liekan-cache-explain');
 *   report.heavyExplain = await collectHeavyExplains({
 *     connectionString: dbConnectionString, benchmarkStamp: stamp,
 *     timingsFinished: true, sites, startAt: range.startAt, endAt: range.endAt,
 *     timezone: range.timezone, chartPeriod: '30d',
 *     matrixSeed: { savedSite, goal, funnel, link, pixel }, // Actual seed IDs.
 *   });
 *   save(); // Persist partial plans before any acceptance assertion/cleanup.
 *   assert(report.heavyExplain.passed, 'heavy-query EXPLAIN collection failed');
 *
 * For a separate process, pass the connection through an existing private env
 * file or child-process environment. Do not put it in CLI arguments or logs.
 */
export interface HeavyExplainOptions {
  connectionString: string;
  benchmarkStamp: string;
  timingsFinished: true;
  /** The benchmark's ten UUIDs; native=0, GEO=3, public share=4. */
  sites: readonly string[];
  startAt: number;
  endAt: number;
  timezone: string;
  chartPeriod?: '30d' | '7d' | '24h';
  matrixSeed: HeavyExplainMatrixSeed;
}

export interface HeavyExplainMatrixSeed {
  savedSite: string;
  goal: string;
  funnel: string;
  link: string;
  pixel: string;
}

/** Parameters and nonempty assertions come from the timed acceptance matrix. */
export function buildHeavyExplainMatrix(
  sites: readonly string[],
  seeded: HeavyExplainMatrixSeed,
): CacheMatrixEntry[] {
  return [
    ...nativeCacheMatrix([...sites]),
    ...supplementalCacheMatrix([...sites], seeded),
    {
      label: 'native-goal',
      site: sites[6],
      target: 'goals/stats',
      extra: { type: 'path', value: '/synthetic/7' },
      validate: b => Number(b.num) > 0 && Number(b.total) >= Number(b.num),
    },
    {
      label: 'native-attribution',
      site: sites[7],
      target: 'attribution',
      extra: { model: 'first-click', type: 'path', step: '/synthetic/8' },
      validate: b =>
        Number(b.total?.pageviews) > 0 && Array.isArray(b.referrer) && b.referrer.length > 0,
    },
    {
      label: 'native-breakdown',
      site: sites[8],
      target: 'breakdown',
      extra: { fields: '["country","browser"]' },
      validate: b => Array.isArray(b) && b.length > 0,
    },
  ];
}

interface SafeFailure {
  name: string;
  code?: string;
  databaseCode?: string;
}
interface CapturedStatement {
  ordinal: number;
  sql: string;
  bindings: unknown[];
  rows?: number;
  elapsedMs?: number;
  failure?: SafeFailure;
  planId: string;
}
interface FunctionRead {
  name: string;
  source: string;
  parameters: Record<string, unknown>;
  statements: CapturedStatement[];
  result?: unknown;
  elapsedMs: number;
  failure?: SafeFailure;
  matrixLabel?: string;
  nonemptyValidated?: boolean;
}
interface ExplainRead {
  id: string;
  sql: string;
  bindings: unknown[];
  referencedBy: string[];
  plan?: unknown;
  elapsedMs: number;
  failure?: SafeFailure;
}

const timeoutMs = 60000;
const explainPrefix = 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const originalFunctionNames = [
  'GEO-human/overview-getHumanFacts',
  'GEO-human/geo-getHumanFacts',
  'GEO-getHumanDays',
  'GEO-getLogFacts',
  'GEO-getPlotLogs',
  'share-getHumanFacts',
  'share-getHumanDays',
  'share-getLogFacts',
  'share-getPlotLogs',
  'native-getWebsiteStats',
  'GEO-all-getHumanFacts',
  'GEO-all-getLogFacts',
  'GEO-monthly-ai',
  'GEO-content-impact',
] as const;
const nativeStatsWindows = [30, 90, 365] as const;

function hasResult(value: unknown) {
  if (value && typeof value === 'object' && 'rows' in value && Array.isArray(value.rows))
    return value.rows.length > 0;
  return Array.isArray(value)
    ? value.length > 0
    : !!value && typeof value === 'object' && Object.keys(value).length > 0;
}

/** A missing branch, missing referenced plan or empty evidence fails acceptance. */
export function heavyExplainCoveragePassed(
  expected: readonly string[],
  functions: readonly FunctionRead[],
  plans: readonly ExplainRead[],
) {
  const names = functions.map(item => item.name);
  const byId = new Map(plans.map(item => [item.id, item]));
  return (
    expected.length > 0 &&
    functions.length === expected.length &&
    new Set(expected).size === expected.length &&
    new Set(names).size === expected.length &&
    expected.every(name => names.includes(name)) &&
    plans.length > 0 &&
    byId.size === plans.length &&
    functions.every(
      item =>
        !item.failure &&
        hasResult(item.result) &&
        (!item.matrixLabel || item.nonemptyValidated === true) &&
        item.statements.length > 0 &&
        item.statements.every(statement => !statement.failure && byId.has(statement.planId)),
    ) &&
    plans.every(item => !item.failure && Array.isArray(item.plan) && item.plan.length > 0)
  );
}

export async function readNativeStatsWindow(
  site: string,
  endAt: number,
  days: (typeof nativeStatsWindows)[number],
  timezone: string,
) {
  const [{ getWebsiteStats }, { getCompareDate }] = await Promise.all([
    import('../src/queries/sql/getWebsiteStats'),
    import('../src/lib/date'),
  ]);
  const current = {
    startDate: new Date(endAt - days * 86400000),
    endDate: new Date(endAt),
    timezone,
  };
  const comparisonRange = getCompareDate('prev', current.startDate, current.endDate);
  const result: unknown = await getWebsiteStats(site, current);
  const comparison = await getWebsiteStats(site, { ...current, ...comparisonRange });
  assert(
    result && typeof result === 'object' && !Array.isArray(result) && 'pageviews' in result,
    'Native statistics must return their actual scalar object contract',
  );
  assert(Number(result.pageviews) > 0, 'Native timed window must have real pageviews');
  return { ...result, comparison };
}

/** Call the production functions with the same schema/filter projection as their GET routes. */
export async function readHeavyMatrixEntry(
  entry: CacheMatrixEntry,
  range: { startAt: number; endAt: number; timezone: string },
  access: { auth: any; request: Request },
) {
  const [schemas, request, date, feature, sql] = await Promise.all([
    import('../src/lib/analytics-schema'),
    import('../src/lib/request'),
    import('../src/lib/date'),
    import('../src/lib/liekan/upstream/feature-analytics'),
    import('../src/queries/sql'),
  ]);
  const input = { ...range, unit: 'day', ...entry.extra };
  if (entry.path?.endsWith('/analytics') && entry.target === 'analytics')
    return feature.featureAnalytics(entry.site, input);
  if (entry.label === 'feature-journey') return feature.featureJourney(entry.site, input);
  if (entry.label === 'feature-saved-goal') {
    const goal = entry.path!.split('/').at(-2)!;
    return feature.featureGoal(entry.site, goal, input, access.auth);
  }
  if (entry.label.startsWith('link-sources')) {
    const { linkSources } = await import('../src/lib/liekan/upstream/link-sources');
    return linkSources(access.request, entry.site, input);
  }
  if (entry.label === 'website-summary') {
    const [{ readWebsiteSummary }, { analyticsCache }] = await Promise.all([
      import('../src/lib/liekan/upstream/website-summary'),
      import('../src/lib/liekan/upstream/query-cache'),
    ]);
    // Summary's outer composition always calls read(), including inside a snapshot.
    // This quiet fresh process forces that one load into the collector's read-only snapshot.
    const originalRead = analyticsCache.read;
    analyticsCache.read = async (_key, _ttl, _tags, load) => {
      const generatedAt = Date.now();
      return {
        value: await load(),
        generatedAt,
        expiresAt: generatedAt,
        status: 'miss',
        tier: 'computed',
      };
    };
    try {
      return await readWebsiteSummary(access.request, input);
    } finally {
      analyticsCache.read = originalRead;
    }
  }
  if (entry.label === 'links-charts' || entry.label === 'pixels-charts')
    return {
      data: await sql.getWebsiteListCharts([entry.site], {
        startDate: new Date(range.startAt),
        endDate: new Date(range.endAt),
        timezone: range.timezone,
        eventType: entry.label === 'links-charts' ? 3 : 4,
      }),
    };

  const schema = (
    {
      'funnels/stats': schemas.funnelQuerySchema,
      retention: schemas.retentionQuerySchema,
      journeys: schemas.journeyQuerySchema,
      'performance/stats': schemas.performanceStatsQuerySchema,
      'performance/chart': schemas.performanceChartQuerySchema,
      'performance/metrics': schemas.performanceMetricsQuerySchema,
      heatmaps: schemas.heatmapQuerySchema,
      'utm/metrics': schemas.utmMetricsQuerySchema,
      'goals/stats': schemas.goalQuerySchema,
      attribution: schemas.attributionQuerySchema,
      breakdown: schemas.breakdownQuerySchema,
    } as Record<string, { parse: (input: unknown) => any }>
  )[entry.target];
  const saved =
    /^goals\/[^/]+\/stats$/.test(entry.target) || /^funnels\/[^/]+\/stats$/.test(entry.target);
  const p: any = saved
    ? schemas.savedStatsQuerySchema.parse(input)
    : schema
      ? schema.parse(input)
      : input;
  const filters = await request.getQueryFilters(p, entry.site);
  const parameters = { ...p, ...filters };
  const previous = () =>
    date.getCompareDate(filters.compare ?? 'prev', filters.startDate, filters.endDate);
  switch (entry.target) {
    case 'events/stats': {
      const { getWebsiteEventStats } = await import(
        '../src/queries/sql/events/getWebsiteEventStats'
      );
      const data = await getWebsiteEventStats(entry.site, filters);
      const comparison = await getWebsiteEventStats(entry.site, { ...filters, ...previous() });
      return { data: { ...data, comparison } };
    }
    case 'metrics/expanded':
      assert.equal(p.type, 'event');
      return sql.getEventExpandedMetrics(
        entry.site,
        { type: p.type, limit: String(p.limit), offset: String(p.offset) },
        { ...filters, eventType: 2 },
      );
    case 'funnels/stats':
      return sql.getFunnel(entry.site, parameters, filters);
    case 'retention':
      return sql.getRetention(entry.site, parameters, filters);
    case 'journeys':
      return sql.getJourney(entry.site, parameters, filters);
    case 'performance/stats':
      return sql.getPerformanceStats(entry.site, parameters, filters);
    case 'performance/chart': {
      const { getPerformanceChart } = await import(
        '../src/queries/sql/performance/getPerformanceChart'
      );
      return getPerformanceChart(entry.site, parameters, filters);
    }
    case 'performance/metrics': {
      const { getPerformanceMetrics } = await import(
        '../src/queries/sql/performance/getPerformanceMetrics'
      );
      const columns = {
        path: 'url_path',
        title: 'page_title',
        device: 'device',
        browser: 'browser',
      };
      return getPerformanceMetrics(
        entry.site,
        parameters,
        filters,
        columns[p.type],
        p.limit ?? (p.type === 'device' ? undefined : 500),
      );
    }
    case 'revenue/stats': {
      const { getRevenueStats } = await import('../src/queries/sql/revenue/getRevenueStats');
      const stats = await getRevenueStats(entry.site, parameters, filters);
      const comparison = await getRevenueStats(
        entry.site,
        { ...parameters, ...previous() },
        filters,
      );
      return { ...stats, comparison };
    }
    case 'revenue/chart': {
      const { getRevenueChart } = await import('../src/queries/sql/revenue/getRevenueChart');
      return getRevenueChart(entry.site, parameters, filters);
    }
    case 'revenue/metrics': {
      const { getRevenueMetrics } = await import('../src/queries/sql/revenue/getRevenueMetrics');
      return getRevenueMetrics(entry.site, parameters, filters, p.type);
    }
    case 'heatmaps':
      return sql.getHeatmap(entry.site, parameters);
    case 'utm/metrics':
      return sql.getUTM(
        entry.site,
        { startDate: filters.startDate, endDate: filters.endDate, column: p.type },
        filters,
      );
    case 'goals/stats': {
      const { getGoal } = await import('../src/queries/sql/goals/getGoal');
      return getGoal(entry.site, parameters, filters);
    }
    case 'attribution': {
      const { getAttribution } = await import('../src/queries/sql/attribution/getAttribution');
      return getAttribution(entry.site, parameters, filters);
    }
    case 'breakdown':
      return sql.getBreakdown(entry.site, parameters, filters);
    default: {
      assert(saved, 'No production function adapter for matrix entry');
      const { getReport } = await import('../src/queries/prisma/report');
      const report = await getReport(entry.target.split('/')[1]);
      assert(report && report.websiteId === entry.site);
      if (entry.target.startsWith('funnels/'))
        return sql.getFunnel(
          entry.site,
          {
            ...schemas.funnelParametersSchema.parse(report.parameters),
            ...filters,
            startDate: filters.startDate,
            endDate: filters.endDate,
          },
          filters,
        );
      const { getGoal } = await import('../src/queries/sql/goals/getGoal');
      const stats = await getGoal(
        entry.site,
        {
          ...schemas.goalParametersSchema.parse(report.parameters),
          ...filters,
          startDate: filters.startDate,
          endDate: filters.endDate,
        },
        filters,
      );
      const detail = await feature.featureGoal(
        entry.site,
        report.id,
        { ...p, unit: filters.unit || 'day' },
        access.auth,
      );
      return { ...stats, series: detail.series, conversions: detail.conversions };
    }
  }
}

/** Normalize before JSON.stringify, including BigInt despite db.ts's toJSON patch. */
function evidence(value: any): any {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Decimal.isDecimal(value)) return value.toString();
  if (Array.isArray(value)) return value.map(evidence);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evidence(item)]));
  return value;
}

/** Omit messages/stacks/meta payloads, which can contain connection credentials. */
function safeFailure(error: any): SafeFailure {
  const code = (value: unknown) =>
    typeof value === 'string' && /^[a-z0-9_-]{1,40}$/i.test(value) ? value : undefined;
  return {
    name: code(error?.name) || 'Error',
    code: code(error?.code),
    databaseCode: code(error?.meta?.code),
  };
}

function syntheticContentBindings(value: string): boolean {
  try {
    const items = JSON.parse(value);
    return (
      Array.isArray(items) &&
      items.length > 0 &&
      items.every(
        item =>
          item &&
          Object.keys(item).every(key => ['path', 'humanPath', 'publishedAt'].includes(key)) &&
          typeof item.path === 'string' &&
          item.path.startsWith('/synthetic/') &&
          typeof item.humanPath === 'string' &&
          item.humanPath.startsWith('/synthetic/') &&
          typeof item.publishedAt === 'string' &&
          Number.isFinite(Date.parse(item.publishedAt)),
      )
    );
  } catch {
    return false;
  }
}

export function heavyExplainBindingAllowed(
  value: unknown,
  allowedStrings: ReadonlySet<string>,
): boolean {
  return (
    value == null ||
    typeof value === 'boolean' ||
    (value instanceof Date && Number.isFinite(value.getTime())) ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) &&
      value.every(item => heavyExplainBindingAllowed(item, allowedStrings))) ||
    (typeof value === 'string' &&
      (allowedStrings.has(value) ||
        metadataTags.has(value) ||
        value.startsWith('/synthetic/') ||
        value.startsWith('synthetic-') ||
        syntheticContentBindings(value)))
  );
}

/** Register only a successful owned metadata read, inside the actual read snapshot. */
export function rememberHeavyExplainVersions(
  sql: string,
  bindings: readonly unknown[],
  rows: unknown,
  ownedSites: ReadonlySet<string>,
  allowedStrings: Set<string>,
): boolean {
  if (
    sql !== rollupVersionsSql ||
    bindings.length !== 4 ||
    typeof bindings[0] !== 'string' ||
    !ownedSites.has(bindings[0]) ||
    bindings[1] !== ANALYSIS_ROLLUP_VERSION ||
    bindings[2] !== TRAFFIC_POLICY_VERSION ||
    bindings[3] !== CRAWLER_POPULATION_VERSION ||
    !Array.isArray(rows) ||
    rows.length !== 1
  )
    return false;
  const versions = rows[0]?.versions;
  if (
    !versions ||
    typeof versions !== 'object' ||
    Array.isArray(versions) ||
    Object.getPrototypeOf(versions) !== Object.prototype ||
    Object.keys(versions).length === 0
  )
    return false;
  // Do not whitelist individual fields or unrelated JSON returned by other reads.
  allowedStrings.add(JSON.stringify(versions));
  return true;
}

function assertRead(sql: string) {
  assert(/^\s*(?:SELECT|WITH)\b/i.test(sql), 'Unexpected non-read analytics SQL');
  assert(
    !/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|COPY|CALL)\b/i.test(sql),
    'Unexpected modifying analytics SQL',
  );
}

export async function collectHeavyExplains(options: HeavyExplainOptions) {
  assert(options.timingsFinished === true, 'All timed scenarios must finish first');
  assert(/^liekan-cache-\d+-[a-f0-9]{12}$/.test(options.benchmarkStamp), 'Invalid benchmark owner');
  assert.equal(options.sites.length, 10, 'Expected the ten isolated synthetic sites');
  assert(
    options.sites.every(id => uuid.test(id)),
    'Invalid synthetic website ID',
  );
  assert(new Set(options.sites.map(id => id.toLowerCase())).size === 10, 'Duplicate website IDs');
  assert(Number.isSafeInteger(options.startAt) && Number.isSafeInteger(options.endAt));
  assert(options.startAt >= 0 && options.endAt >= options.startAt);
  assert(options.endAt - options.startAt <= 1096 * 86400000, 'Unsupported report range');
  assert(options.matrixSeed, 'The actual acceptance matrix seed is required');
  assert.equal(options.matrixSeed.savedSite, options.sites[5]);
  assert(
    Object.values(options.matrixSeed).every(id => uuid.test(id)),
    'Invalid matrix seed ID',
  );
  const matrix = buildHeavyExplainMatrix(options.sites, options.matrixSeed);
  assert.equal(matrix.length, 34, 'The complete native/supplemental matrix is required');
  const expectedFunctions = [
    ...originalFunctionNames,
    ...nativeStatsWindows.map(days => `native-${days}-getWebsiteStats`),
    ...matrix.map(entry => `matrix-${entry.label}`),
  ];
  assert.equal(new Set(expectedFunctions).size, expectedFunctions.length);
  new Intl.DateTimeFormat('en', { timeZone: options.timezone }).format();

  let url: URL;
  try {
    url = new URL(options.connectionString);
  } catch {
    throw new Error('Invalid isolated database configuration');
  }
  assert(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL is required');
  assert(
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    'Expected an isolated local DB',
  );
  assert.equal(url.pathname, '/bench', 'Expected the benchmark database');
  const schema = url.searchParams.get('schema') || 'public';
  assert(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema), 'Invalid synthetic database schema');
  assert(!(globalThis as any).prisma, 'Run before Prisma initialization or use a fresh process');

  // The actual application's lazily imported Prisma client must target this DB.
  // Hooks below route both native and Liekan reads to the same primary snapshot.
  const envKeys = [
    'DATABASE_URL',
    'DATABASE_REPLICA_URL',
    'CLICKHOUSE_URL',
    'LOG_QUERY',
    'DEBUG',
    'REDIS_URL',
    'LIEKAN_ANALYTICS_REDIS_URL',
    'CLOUD_MODE',
  ];
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  process.env.DATABASE_URL = options.connectionString;
  for (const key of envKeys.slice(1)) delete process.env[key];

  let primary: any;
  const functions: FunctionRead[] = [];
  const plans = new Map<string, ExplainRead>();
  const startedAt = new Date().toISOString();
  const ownedSites = new Set(options.sites);
  const allowedStrings = new Set<string>([
    '',
    options.timezone,
    ...options.sites,
    ...Object.values(options.matrixSeed),
  ]);
  const allowMatrixValue = (value: unknown) => {
    if (typeof value === 'string') {
      allowedStrings.add(value);
      try {
        allowMatrixValue(JSON.parse(value));
      } catch {}
    } else if (Array.isArray(value)) value.forEach(allowMatrixValue);
    else if (value && typeof value === 'object') Object.values(value).forEach(allowMatrixValue);
  };
  matrix.forEach(entry => allowMatrixValue(entry.extra));
  const syntheticBinding = (value: unknown) => heavyExplainBindingAllowed(value, allowedStrings);
  try {
    const [prismaModule, snapshots, metadata, contexts, human, logs, native, pages, shared] =
      await Promise.all([
        import('../src/lib/prisma'),
        import('../src/lib/liekan/upstream/query-snapshot'),
        import('../src/lib/liekan/upstream/analytics-deadline'),
        import('../src/lib/liekan/upstream/cache-context'),
        import('../src/lib/liekan/upstream/analytics'),
        import('../src/lib/liekan/upstream/logs'),
        import('../src/queries/sql/getWebsiteStats'),
        import('../src/lib/liekan/contracts/page-report'),
        import('../src/lib/liekan/contracts/shared-report'),
      ]);
    primary = prismaModule.getRawQueryClient(prismaModule.default.client, { write: true });
    assert(
      !snapshots.getQuerySnapshot() && !metadata.primaryMetadataClient(),
      'Unexpected active snapshot',
    );

    const readSnapshot = async <T>(work: (tx: any) => Promise<T>, record?: FunctionRead) =>
      primary.$transaction(
        async (raw: any) => {
          const executor = new Proxy(raw, {
            get(target, key) {
              const member = Reflect.get(target, key);
              if (key === '$queryRawUnsafe' && record)
                return async (sql: string, ...bindings: any[]) => {
                  assertRead(sql);
                  for (const value of bindings)
                    assert(syntheticBinding(value), 'Unexpected non-synthetic analytics binding');
                  const normalized = evidence(bindings);
                  const planId = createHash('sha256')
                    .update(JSON.stringify([sql, normalized]))
                    .digest('hex');
                  const statement: CapturedStatement = {
                    ordinal: record.statements.length + 1,
                    sql,
                    bindings: normalized,
                    planId,
                  };
                  record.statements.push(statement);
                  let plan = plans.get(planId);
                  if (!plan) {
                    plan = { id: planId, sql, bindings, referencedBy: [], elapsedMs: 0 };
                    plans.set(planId, plan);
                  }
                  if (!plan.referencedBy.includes(record.name)) plan.referencedBy.push(record.name);
                  const began = Date.now();
                  try {
                    const rows = await member.call(target, sql, ...bindings);
                    rememberHeavyExplainVersions(sql, bindings, rows, ownedSites, allowedStrings);
                    statement.rows = Array.isArray(rows) ? rows.length : undefined;
                    return rows;
                  } catch (error) {
                    statement.failure = safeFailure(error);
                    throw error;
                  } finally {
                    statement.elapsedMs = Date.now() - began;
                  }
                };
              return typeof member === 'function' ? member.bind(target) : member;
            },
          });
          const tx = metadata.timedAnalyticsClient(executor, Date.now() + timeoutMs);
          await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
          return metadata.withinPrimaryMetadata(tx, () =>
            snapshots.withinQuerySnapshot(tx, () =>
              contexts.withoutQueryCache(async () => {
                assert.strictEqual(snapshots.getQuerySnapshot(), tx);
                assert.strictEqual(metadata.primaryMetadataClient(), tx);
                assert.equal(contexts.cacheHeadersEnabled(), false);
                return work(tx);
              }),
            ),
          );
        },
        { isolationLevel: 'RepeatableRead', timeout: timeoutMs, maxWait: 5000 },
      ) as Promise<T>;

    // Fail closed on a wrong database/resource without printing any connection data.
    const owned = await readSnapshot(async tx =>
      tx.$queryRawUnsafe(
        'SELECT website_id::text AS id,name,domain FROM website WHERE website_id=ANY($1::uuid[])',
        [...options.sites],
      ),
    );
    assert.equal(owned.length, 10, 'Synthetic ownership check failed');
    for (const [i, id] of options.sites.entries()) {
      const row = owned.find((item: any) => item.id === id.toLowerCase());
      const ownedName =
        row?.name === `缓存基准合成站点 ${i + 1}` ||
        (i === 0 && row?.name === '缓存基准更新后的站点');
      assert(
        ownedName && row.domain === 'analytics-benchmark.invalid',
        'Synthetic ownership check failed',
      );
    }

    const seeded = options.matrixSeed;
    const ownership = await readSnapshot(async tx => {
      const reports = await tx.$queryRawUnsafe(
        'SELECT report_id::text AS id,website_id::text AS site,user_id::text AS actor,type,name,parameters FROM report WHERE report_id=ANY($1::uuid[])',
        [seeded.goal, seeded.funnel],
      );
      assert.equal(reports.length, 2, 'Synthetic saved definitions are required');
      for (const [id, type, name] of [
        [seeded.goal, 'goal', '验收合成目标'],
        [seeded.funnel, 'funnel', '验收合成漏斗'],
      ]) {
        const report = reports.find((item: any) => item.id === id.toLowerCase());
        assert(
          report &&
            report.site === seeded.savedSite.toLowerCase() &&
            report.type === type &&
            report.name === name,
        );
      }
      const actor = reports[0].actor;
      assert(uuid.test(actor) && reports.every((item: any) => item.actor === actor));
      const resources = await tx.$queryRawUnsafe(
        `SELECT link_id::text AS id,user_id::text AS actor,name,slug,url FROM link WHERE link_id=$1::uuid AND deleted_at IS NULL
         UNION ALL SELECT pixel_id::text,user_id::text,name,slug,NULL FROM pixel WHERE pixel_id=$2::uuid AND deleted_at IS NULL`,
        seeded.link,
        seeded.pixel,
      );
      assert.equal(resources.length, 2);
      for (const [id, name] of [
        [seeded.link, '验收合成链接'],
        [seeded.pixel, '验收合成图片'],
      ]) {
        const resource = resources.find((item: any) => item.id === id.toLowerCase());
        assert(
          resource &&
            resource.actor === actor &&
            resource.name === name &&
            resource.slug === `benchmark-${id}`,
        );
        if (id === seeded.link)
          assert.equal(resource.url, 'https://analytics-benchmark.invalid/synthetic');
      }
      const users = await tx.$queryRawUnsafe(
        'SELECT user_id::text AS id,username,role FROM "user" WHERE user_id=$1::uuid AND deleted_at IS NULL',
        actor,
      );
      assert.equal(users.length, 1);
      assert.equal(
        users[0].role,
        'admin',
        'The isolated benchmark owner must authorize the matrix',
      );
      return { ...users[0], isAdmin: true };
    });
    allowedStrings.add(ownership.id);
    const [{ createSecureToken }, { secret }] = await Promise.all([
      import('../src/lib/jwt'),
      import('../src/lib/crypto'),
    ]);
    // A local owner token is used only by the real in-process read functions.
    // It is never sent over the network or included in evidence/logs.
    const privateRequest = new Request('http://127.0.0.1/synthetic-explain', {
      headers: { authorization: `Bearer ${createSecureToken({ userId: ownership.id }, secret())}` },
    });

    const start = new Date(options.startAt),
      end = new Date(options.endAt);
    const period = options.chartPeriod || '30d';
    assert(['30d', '7d', '24h'].includes(period), 'Invalid report chart period');
    const periodDays = { '30d': 30, '7d': 7, '24h': 1 }[period];
    const plotStart = (share: boolean) =>
      new Date(Math.max(share ? options.startAt : 0, options.endAt - periodDays * 86400000));
    const hour = period === '24h';
    const take = async (
      name: string,
      source: string,
      parameters: Record<string, unknown>,
      work: () => Promise<unknown>,
      entry?: CacheMatrixEntry,
    ) => {
      const record: FunctionRead = {
        name,
        source,
        parameters: evidence(parameters),
        statements: [],
        elapsedMs: 0,
        ...(entry ? { matrixLabel: entry.label, nonemptyValidated: false } : {}),
      };
      functions.push(record);
      const began = Date.now();
      try {
        const result = await readSnapshot(() => work(), record);
        record.result = evidence(result);
        assert(record.statements.length > 0, 'Actual analytics SQL was not captured');
        assert(hasResult(record.result), 'Actual function result must be nonempty');
        if (entry) {
          assert(
            entry.validate(record.result),
            'Actual matrix data must pass its nonempty field assertions',
          );
          record.nonemptyValidated = true;
        }
      } catch (error) {
        record.failure = safeFailure(error);
      } finally {
        record.elapsedMs = Date.now() - began;
      }
    };

    const geo = options.sites[3],
      share = options.sites[4],
      tz = options.timezone;
    for (const [resource, parts] of [
      ['human/overview', pages.pageReportParts['human/overview']],
      ['human/geo', pages.pageReportParts['human/geo']],
    ] as const) {
      await take(
        `GEO-${resource}-getHumanFacts`,
        'src/lib/liekan/upstream/analytics.ts:getHumanFacts',
        { websiteId: geo, start, end, timezone: tz, fields: parts.human },
        () => human.getHumanFacts(geo, start, end, tz, parts.human),
      );
    }
    await take(
      'GEO-getHumanDays',
      'src/lib/liekan/upstream/analytics.ts:getHumanDays',
      { websiteId: geo, start: plotStart(false), end, timezone: tz, hour },
      () => human.getHumanDays(geo, plotStart(false), end, tz, hour),
    );
    await take(
      'GEO-getLogFacts',
      'src/lib/liekan/upstream/logs.ts:getLogFacts',
      {
        websiteId: geo,
        start,
        end,
        timezone: tz,
        fields: pages.pageReportParts['human/overview'].logs,
      },
      () =>
        logs.getLogFacts(
          geo,
          start,
          end,
          tz,
          1,
          '',
          '',
          '',
          'after',
          pages.pageReportParts['human/overview'].logs,
        ),
    );
    await take(
      'GEO-getPlotLogs',
      'src/lib/liekan/upstream/logs.ts:getPlotLogs',
      { websiteId: geo, start: plotStart(false), end, timezone: tz, hour },
      () => logs.getPlotLogs(geo, plotStart(false), end, tz, hour),
    );
    await take(
      'share-getHumanFacts',
      'src/lib/liekan/upstream/analytics.ts:getHumanFacts',
      { websiteId: share, start, end, timezone: tz, fields: shared.sharedReportParts.human },
      () => human.getHumanFacts(share, start, end, tz, shared.sharedReportParts.human),
    );
    await take(
      'share-getHumanDays',
      'src/lib/liekan/upstream/analytics.ts:getHumanDays',
      { websiteId: share, start: plotStart(true), end, timezone: tz, hour },
      () => human.getHumanDays(share, plotStart(true), end, tz, hour),
    );
    await take(
      'share-getLogFacts',
      'src/lib/liekan/upstream/logs.ts:getLogFacts',
      { websiteId: share, start, end, timezone: tz, fields: shared.sharedReportParts.logs },
      () =>
        logs.getLogFacts(
          share,
          start,
          end,
          tz,
          1,
          '',
          '',
          '',
          'after',
          shared.sharedReportParts.logs,
        ),
    );
    await take(
      'share-getPlotLogs',
      'src/lib/liekan/upstream/logs.ts:getPlotLogs',
      { websiteId: share, start: plotStart(true), end, timezone: tz, hour },
      () => logs.getPlotLogs(share, plotStart(true), end, tz, hour),
    );
    await take(
      'native-getWebsiteStats',
      'src/queries/sql/getWebsiteStats.ts:getWebsiteStats',
      { websiteId: options.sites[0], startDate: start, endDate: end, timezone: tz },
      () =>
        native.getWebsiteStats(options.sites[0], { startDate: start, endDate: end, timezone: tz }),
    );
    for (const [index, days] of nativeStatsWindows.entries()) {
      const current = {
        startDate: new Date(options.endAt - days * 86400000),
        endDate: end,
        timezone: tz,
      };
      await take(
        `native-${days}-getWebsiteStats`,
        'src/app/api/websites/[websiteId]/stats/route.ts:getWebsiteStats/current+comparison',
        { websiteId: options.sites[index], ...current },
        () => readNativeStatsWindow(options.sites[index], options.endAt, days, tz),
      );
    }

    const meaningfulGeo = options.sites[5];
    await take(
      'GEO-all-getHumanFacts',
      'src/lib/liekan/upstream/analytics.ts:getHumanFacts',
      { websiteId: meaningfulGeo, start, end, timezone: tz, fields: 'all' },
      () => human.getHumanFacts(meaningfulGeo, start, end, tz),
    );
    await take(
      'GEO-all-getLogFacts',
      'src/lib/liekan/upstream/logs.ts:getLogFacts',
      { websiteId: meaningfulGeo, start, end, timezone: tz, fields: 'all' },
      () => logs.getLogFacts(meaningfulGeo, start, end, tz),
    );
    await take(
      'GEO-monthly-ai',
      'src/lib/liekan/upstream/logs.ts:getMonthlyAiShare',
      { websiteId: meaningfulGeo, end, timezone: tz },
      () => logs.getMonthlyAiShare(meaningfulGeo, end, tz),
    );

    await take(
      'GEO-content-impact',
      'src/lib/liekan/upstream/logs.ts:getContentImpact',
      { websiteId: meaningfulGeo, start, end },
      () => logs.getContentImpact(meaningfulGeo, start, end),
    );

    for (const entry of matrix) {
      await take(
        `matrix-${entry.label}`,
        entry.path || `/api/websites/${entry.site}/${entry.target}`,
        {
          websiteId: entry.site,
          startAt: options.startAt,
          endAt: options.endAt,
          timezone: tz,
          unit: 'day',
          ...entry.extra,
        },
        () =>
          readHeavyMatrixEntry(
            entry,
            {
              startAt: options.startAt,
              endAt: options.endAt,
              timezone: tz,
            },
            { auth: { user: ownership }, request: privateRequest },
          ),
        entry,
      );
    }

    // Replay the actual final bound SQL, including every CTE/projection/metadata read.
    // Identical SQL+bindings share a plan, with every calling function retained.
    for (const entry of plans.values()) {
      const began = Date.now();
      try {
        assertRead(entry.sql);
        const rows: any = await readSnapshot(tx =>
          tx.$queryRawUnsafe(explainPrefix + entry.sql, ...entry.bindings),
        );
        assert(
          Array.isArray(rows) && rows.length === 1 && Array.isArray(rows[0]['QUERY PLAN']),
          'PostgreSQL did not return a JSON execution plan',
        );
        entry.plan = evidence(rows[0]['QUERY PLAN']);
      } catch (error) {
        entry.failure = safeFailure(error);
      } finally {
        entry.elapsedMs = Date.now() - began;
      }
    }
    const indexes: any = await readSnapshot(tx =>
      tx.$queryRawUnsafe(
        `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1
       AND tablename IN('website_event','session','report','revenue','heatmap_event','event_data','session_data','link','pixel','liekan_log','liekan_log_interval','liekan_import','liekan_catalog')
       ORDER BY tablename,indexname`,
        schema,
      ),
    );
    return {
      passed: heavyExplainCoveragePassed(expectedFunctions, functions, [...plans.values()]),
      coverage: {
        expectedFunctions,
        originalFunctions: originalFunctionNames.length,
        nativeStatsWindows: [...nativeStatsWindows],
        matrixBranches: matrix.length,
        matrixLabels: matrix.map(entry => entry.label),
        resultCacheBypassed: true,
      },
      startedAt,
      finishedAt: new Date().toISOString(),
      timeoutMs,
      isolation: 'RepeatableRead/read-only/primary',
      actualReadsAndExplainsUseSeparateSnapshots: true,
      benchmarkStamp: options.benchmarkStamp,
      range: { startAt: options.startAt, endAt: options.endAt, timezone: tz, chartPeriod: period },
      functions,
      plans: [...plans.values()].map(entry => ({ ...entry, bindings: evidence(entry.bindings) })),
      indexes: evidence(indexes),
      dataShapeLimitations: [
        'Execution plans describe the synthetic distribution and the recorded current indexes.',
        'The synthetic GEO fixture includes catalog evidence, three AI types, source intervals and download goals.',
        'EXPLAIN replay and actual function reads are post-timing evidence; these elapsedMs are not acceptance latency samples.',
        'Matrix reads use the actual production analytics functions, authoritative parameter schemas and request filter projection. Raw bound analytics statements are replayed; ORM permission/definition metadata is checked inside the same read-only snapshot.',
      ],
    };
  } catch (error) {
    const failure = safeFailure(error);
    throw new Error(
      `Heavy EXPLAIN setup failed (${failure.name}${failure.code ? ':' + failure.code : ''})`,
    );
  } finally {
    await primary?.$disconnect().catch(() => {});
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
