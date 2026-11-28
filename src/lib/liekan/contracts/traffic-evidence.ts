import { z } from 'zod';
import { browserPopulationSchema } from './browser-population';
import { crawlerIdentityScopeSchema, evidenceStateSchema } from './crawler-metrics';
import { crawlerPathSchema } from './crawlers';

const reportDisplaySchema = z.object({
  filter: z.string().max(100),
  search: z.string().max(200),
  sort: z.object({ label: z.string().max(100), direction: z.union([z.literal(1), z.literal(-1)]) }),
});
const reportDisplayQuerySchema = z.preprocess(value => {
  if (typeof value !== 'string') return value;
  if (value.length > 2000) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}, reportDisplaySchema.optional());
export const evidenceQuerySchema = z.strictObject({
  reportResource: z.enum(['ai/bots', 'ai/pages', 'logs']).optional(),
  reportDisplay: reportDisplayQuerySchema,
  recognitionGroup: z.literal('ambiguous').optional(),
  startAt: z.coerce.number().int().nonnegative(),
  endAt: z.coerce.number().int().nonnegative(),
  timezone: z.string().max(80).default('UTC'),
  sourceId: z.union([z.uuid(), z.literal('manual')]).optional(),
  botId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,79}$/)
    .optional(),
  botType: z.enum(['训练', '搜索', '用户触发', '传统搜索', '其他']).optional(),
  botProductForm: z.enum(['workbench', 'personal_agent']).optional(),
  botCategory: z.literal('other').optional(),
  botName: z.string().min(1).max(80).optional(),
  population: z
    .enum(['recognized_crawlers', 'ai_crawlers', 'all_logs'])
    .default('recognized_crawlers'),
  dimension: z.enum(['bot', 'path', 'day']).default('bot'),
  search: z.string().max(200).optional(),
  logFilter: z.enum(['ai', 'abnormal', 'other']).optional(),
  view: z.enum(['matrix', 'requests', 'summary']).default('matrix'),
  responseGroup: z.enum(['1xx', '2xx', '3xx', '304', 'denied', 'other4xx', '5xx']).optional(),
  verificationGroup: z
    .enum(['verified_range', 'verified_dns', 'verified_edge', 'range_mismatch', 'unverified'])
    .optional(),
  path: crawlerPathSchema.shape.value.optional(),
  crawlerIdentityScope: crawlerIdentityScopeSchema.default('all'),
  crawlerMetricsVersion: z.coerce.number().pipe(z.literal(1)).default(1),
  page: z.coerce
    .number()
    .int()
    .min(1)
    .max(Math.floor(Number.MAX_SAFE_INTEGER / 20))
    .default(1),
  reasonsPage: z.coerce
    .number()
    .int()
    .min(1)
    .max(Math.floor(Number.MAX_SAFE_INTEGER / 20))
    .optional(),
  fieldCoveragePage: z.coerce
    .number()
    .int()
    .min(1)
    .max(Math.floor(Number.MAX_SAFE_INTEGER / 20))
    .optional(),
  sort: z.enum(['requests', 'visits', 'path']).default('requests'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  snapshot: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const performanceQuerySchema = evidenceQuerySchema
  .omit({
    botProductForm: true,
    botCategory: true,
    view: true,
    responseGroup: true,
    verificationGroup: true,
    reportResource: true,
    reportDisplay: true,
    recognitionGroup: true,
  })
  .required({ sourceId: true });
export const observationQuerySchema = evidenceQuerySchema
  .pick({
    timezone: true,
    page: true,
    snapshot: true,
    sort: true,
    direction: true,
    crawlerMetricsVersion: true,
  })
  .extend({
    startAt: z.coerce.number().int().nonnegative().optional(),
    endAt: z.coerce.number().int().nonnegative().optional(),
    subset: z.enum(['raw', 'eligible']).default('raw'),
  });
export type EvidenceQuery = z.infer<typeof evidenceQuerySchema>;
export const reconciliationQuerySchema = evidenceQuerySchema
  .omit({
    reportResource: true,
    reportDisplay: true,
    recognitionGroup: true,
    population: true,
    dimension: true,
    search: true,
    logFilter: true,
    botId: true,
    botName: true,
    botType: true,
    botProductForm: true,
    botCategory: true,
    view: true,
    responseGroup: true,
    verificationGroup: true,
    crawlerIdentityScope: true,
  })
  .extend({
    sourceId: z.union([z.uuid(), z.literal('manual')]),
    hostname: z.string().min(1).max(253),
  });
export type ReconciliationQuery = z.infer<typeof reconciliationQuerySchema>;
export const evidenceExportSchema = z.strictObject({
  viewReportQuery: z.record(z.string(), z.unknown()).optional(),
  kind: z.enum(['evidence', 'reconciliation', 'performance', 'outcomes', 'observations']),
  query: z.record(z.string(), z.unknown()),
  locale: z.enum(['zh-CN', 'en-US']),
  viewSnapshot: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  policySnapshot: z.string().regex(/^[a-f0-9]{64}$/),
});

export const metricValueSchema = z.object({
  value: z.union([z.number(), z.string()]).nullable(),
  state: evidenceStateSchema,
  reasonCode: z.string().nullable(),
  sampleCount: z.number(),
  populationCount: z.number(),
  coverage: z.number().nullable(),
  timeBasis: z.enum(['event_time', 'received_at']),
  metricVersion: z.literal('crawler-metrics-v1'),
});
const metricMap = z.record(z.string(), metricValueSchema);
const counts = z.record(z.string(), z.number().nullable());
export const observationIdentitySchema = z.object({
  version: z.literal('received-browser-identity-v1'),
  timeBasis: z.literal('received_at'),
  population: z.enum(['raw_public_pv', 'eligible_public_pv']),
  range: z.object({
    startAt: z.number(),
    endAt: z.number(),
    timezone: z.string(),
    endExclusive: z.literal(true),
  }),
  status: z.enum(['complete', 'partial', 'unavailable', 'empty']),
  totalPV: z.number(),
  qualifiedPV: z.number(),
  qualifiedVisitors: z.number(),
  coverage: z.number().nullable(),
  versions: z.array(z.string()),
  versionsTruncated: z.boolean(),
});
export const evidenceMetaSchema = z.looseObject({
  browserPopulation: browserPopulationSchema.optional(),
  observationIdentity: observationIdentitySchema.optional(),
  metricVersion: z.literal('crawler-metrics-v1'),
  timeBasis: z.enum(['event_time', 'received_at']),
  timeBoundary: z.literal('half_open'),
  conditions: z.looseObject({ startAt: z.number(), endAt: z.number(), timezone: z.string() }),
  population: z.string(),
  readAt: z.string(),
  snapshot: z.string(),
  policySnapshot: z.string(),
  registryVersion: z.uuid().nullable().optional(),
  populationVersion: z.string().optional(),
  catalogBaseline: z.string(),
  epoch: z.number().int(),
  policy: z.looseObject({ mode: z.string(), revision: z.string() }),
  dataRevision: z.string(),
  sources: z.array(
    z.object({ id: z.uuid(), kind: z.string(), domain: z.string(), state: z.string() }),
  ),
  quality: z.object({
    state: z.enum(['complete', 'partial', 'unknown', 'missing', 'unsupported']),
    basis: z.enum(['event_time', 'ingestion_time', 'unknown']),
    classificationVersion: z.string(),
    sourceVersion: z.string(),
    timezone: z.string(),
  }),
  page: z.number().int(),
  pageSize: z.literal(20),
  total: z.number().int(),
  reset: z.boolean(),
});
const base = z.object({ meta: evidenceMetaSchema });
const matrixRow = z.object({
  identity: z.enum([
    'verified_range',
    'verified_dns',
    'verified_edge',
    'range_mismatch',
    'unverified',
  ]),
  response: z.enum(['1xx', '2xx', '3xx', '304', 'denied', 'other4xx', '5xx']),
  requests: z.number(),
});
export const crawlerEvidenceResponseSchema = z.union([
  base.extend({
    table: z.enum(['botBody', 'apBody', 'logBody']),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  }),
  base.extend({
    rows: z.array(matrixRow),
    outsideScope: z.array(matrixRow),
    ambiguousRequests: z.number().nonnegative(),
    totals: counts,
    reasons: z.array(z.object({ reason: z.string(), requests: z.number() })),
    coverage: metricValueSchema,
  }),
  base.extend({
    rows: z.array(
      z.object({
        id: z.string(),
        time: z.string(),
        path: z.string(),
        method: z.string(),
        status: z.number(),
        bot: z.string(),
        verification: z.string(),
      }),
    ),
    outsideScope: z.array(matrixRow),
  }),
  base.extend({
    rows: z.array(
      z.object({
        name: z.string(),
        requests: z.number(),
        pages: z.number(),
        get2xx: z.number(),
        abnormal: z.number(),
        lastVisit: z.string(),
      }),
    ),
  }),
]);
export const reconciliationResponseSchema = base.extend({
  rows: z.array(
    z.object({
      humanPath: z.string(),
      encodedPaths: z.array(z.string()),
      collisionPaths: z.array(z.string()),
      ambiguous: z.boolean(),
      requests: z.number(),
      get2xx: z.number(),
      crawler: z.number(),
      candidate: z.number(),
      ambiguousRequests: z.number(),
      confirmedHtml: z.number(),
      contentType: metricValueSchema,
      observedPv: z.number().nullable(),
      unknownHostPv: z.number(),
      pv: z.number().nullable(),
      uv: z.number().nullable(),
      visits: z.number().nullable(),
      difference: metricValueSchema,
    }),
  ),
  browserTotals: counts.nullable(),
  state: evidenceStateSchema,
  reasonCode: z.string().nullable(),
  rawRequests: z.number(),
});
export const performanceResponseSchema = base.extend({
  rows: z.array(
    z.object({
      unit: z.enum(['edge_body', 'combined_response', 'unknown']),
      requests: z.number(),
      samples: z.number(),
      observedBytes: z.string().nullable(),
      peakMinuteBytes: z.string().nullable(),
      observedPeakBytesPerSecond: z.string().nullable(),
      bytes: metricValueSchema,
    }),
  ),
  fieldCoverage: z.array(
    z.object({
      field: z.string(),
      state: z.enum(['present', 'missing', 'unsupported', 'invalid', 'unknown']),
      value: z.union([z.string(), z.number()]).nullable(),
      requests: z.number(),
    }),
  ),
  totals: counts,
  coverage: metricMap,
  reasons: z.array(z.object({ status: z.string(), requests: z.number() })),
});
const outcomeCounts = z.object({
  platformId: z.string(),
  requests: z.number(),
  get2xx: z.number(),
  catalogPaths: z.number(),
  visits: z.number().nullable(),
  conversions: z.number().nullable(),
  goalEvents: z.number().nullable(),
  conversionRate: z.number().nullable(),
});
export const outcomesResponseSchema = base.extend({
  rows: z.array(
    outcomeCounts.extend({
      path: z.string(),
      observedVisits: z.number().nullable(),
      unknownBrowserHost: z.number().nullable(),
      browserHostKnown: z.boolean(),
      ambiguous: z.boolean(),
      unsampled: z.boolean().nullable(),
      hostObserved: z.boolean(),
      configKnown: z.boolean(),
      ratioDenominator: z.number().nullable(),
      ratio: metricValueSchema,
    }),
  ),
  reasons: z.array(outcomeCounts),
  totals: counts,
});
export const observationsResponseSchema = base.extend({
  rows: z.array(
    z.object({
      browser: z.string(),
      source: z.string(),
      classification: z.string(),
      version: z.string(),
      features: z
        .record(
          z.string(),
          z.object({
            state: z.enum(['present', 'missing', 'invalid']),
            values: z.array(z.string()),
          }),
        )
        .nullable(),
      pv: z.number(),
      uv: z.number().nullable(),
      smallSample: z.boolean(),
      firstEventAt: z.string(),
      lastEventAt: z.string(),
    }),
  ),
  totals: counts,
  coverage: metricMap,
  state: evidenceStateSchema,
  reasonCode: z.string().nullable(),
});
export const trafficEvidenceResponseSchema = z.union([
  crawlerEvidenceResponseSchema,
  reconciliationResponseSchema,
  performanceResponseSchema,
  outcomesResponseSchema,
  observationsResponseSchema,
]);
