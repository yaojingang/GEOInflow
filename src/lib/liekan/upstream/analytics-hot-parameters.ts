import { z } from 'zod';
import { CALENDAR_POLICY_VERSION } from '../contracts/calendar';
import { ANALYTICS_READ_VERSION } from './analytics-revision';
import * as schemas from '@/lib/analytics-schema';
import { EVENT_COLUMNS, SESSION_COLUMNS } from '@/lib/constants';
import { filterParams, withDateRange } from '@/lib/schema';
import { analysisQuery, journeyQuery } from '../contracts/analysis';
import { parseReportQuery } from '../contracts/query';
import { sharedReportQuery } from '../contracts/shared-report';

export const analyticsRefreshJobSchema = z
  .object({
    websiteId: z.uuid(),
    target: z.enum([
      'native:stats',
      'native:pageviews',
      'native:metrics',
      'native:events/stats',
      'native:events/series',
      'native:goals/stats',
      'native:funnels/stats',
      'native:retention',
      'native:journeys',
      'native:breakdown',
      'native:attribution',
      'native:heatmap',
      'native:heatmaps',
      'native:performance/stats',
      'native:performance/chart',
      'native:performance/metrics',
      'native:revenue/stats',
      'native:revenue/chart',
      'native:revenue/metrics',
      'native:utm/metrics',
      'feature:page-report',
      'feature:shared-report',
      'feature:analytics',
      'feature:journeys',
    ]),
    parameters: z.record(z.string(), z.unknown()),
    actorId: z.uuid().optional(),
    shareId: z.uuid().optional(),
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedStrongVersion: z.string().max(16384),
    scheduledAt: z.number().int().min(0),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine(job => Boolean(job.actorId) !== Boolean(job.shareId));

/** The accepted catalog is already persisted in the strong version; legacy jobs have none. */
export function analyticsHotCatalogVersion(strongVersion: string): string | undefined {
  try {
    const version = JSON.parse(strongVersion);
    if (!Array.isArray(version)) return undefined;
    if (
      (version.length === 7 ||
        (version.length === 8 && version[7] === CALENDAR_POLICY_VERSION) ||
        (version.length === 9 && version[7] === ANALYTICS_READ_VERSION && version[8] === CALENDAR_POLICY_VERSION)) &&
      ['history-repair-v1.1', 'history-repair-v1.2'].includes(version[1]) &&
      z.uuid().safeParse(version[3]).success
    )
      return version[3];
    if (version.length === 5 && z.uuid().safeParse(version[1]).success) return version[1];
  } catch {
    // Older hot registrations are renewed against the current catalog.
  }
  return undefined;
}

const nativeSchemas: Record<string, z.ZodType> = {
  'goals/stats': schemas.goalQuerySchema,
  'funnels/stats': schemas.funnelQuerySchema,
  retention: schemas.retentionQuerySchema,
  journeys: schemas.journeyQuerySchema,
  breakdown: schemas.breakdownQuerySchema,
  attribution: schemas.attributionQuerySchema,
  heatmap: schemas.heatmapQuerySchema,
  heatmaps: schemas.heatmapQuerySchema,
  'performance/stats': schemas.performanceStatsQuerySchema,
  'performance/chart': schemas.performanceChartQuerySchema,
  'performance/metrics': schemas.performanceMetricsQuerySchema,
  'utm/metrics': schemas.utmMetricsQuerySchema,
  metrics: withDateRange({
    ...filterParams,
    search: z.string().max(500).optional(),
    offset: z.coerce.number().int().min(0).max(100000).optional(),
    type: z.enum(['channel', ...SESSION_COLUMNS, ...EVENT_COLUMNS]),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }),
  'revenue/metrics': withDateRange({
    ...filterParams,
    type: z.enum(['country', 'region', 'referrer', 'channel']),
    currency: z.string().max(10),
  }),
};

/** Queue values have already passed GET parsing; round-trip only JSON wire fields before validation. */
export function parseAnalyticsHotParameters(target: string, input: Record<string, any>) {
  const parameters = { ...input };
  if (target === 'native:breakdown' && Array.isArray(parameters.fields))
    parameters.fields = JSON.stringify(parameters.fields);
  if (target === 'native:funnels/stats' && Array.isArray(parameters.steps))
    parameters.steps = JSON.stringify(parameters.steps);
  if (target === 'feature:page-report') {
    const parsed = parseReportQuery(parameters);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  }
  if (target === 'feature:shared-report') return sharedReportQuery.parse(parameters);
  if (target === 'feature:analytics') return analysisQuery.parse(parameters);
  if (target === 'feature:journeys') return journeyQuery.parse(parameters);
  const native = target.slice('native:'.length);
  return (
    nativeSchemas[native] ||
    withDateRange({
      ...filterParams,
      limit: z.coerce.number().int().min(1).max(500).optional(),
      currency: z.string().max(10).optional(),
    })
  ).parse(parameters);
}
