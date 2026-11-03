import { browserPopulationSchema, type BrowserPopulation } from './browser-population';
import { crawlerIdentityScopeSchema, type CrawlerIdentityScope } from './crawler-metrics';
import { z } from 'zod';
import type { GeographyDisplay, GeographyCoverage } from './geography';
export const geographyCoverageSchema = z.object({
  displayRuleVersion: z.string(),
  totalVisits: z.number().int().nonnegative(),
  cityKnownVisits: z.number().int().nonnegative(),
  cityUnknownVisits: z.number().int().nonnegative(),
  cityCoverage: z.number().min(0).max(100).nullable(),
  chinaVisits: z.number().int().nonnegative(),
  chinaProvinceKnownVisits: z.number().int().nonnegative(),
  chinaProvinceUnknownVisits: z.number().int().nonnegative(),
  chinaProvinceCoverage: z.number().min(0).max(100).nullable(),
  cityDisplayState: z.enum(['empty', 'unidentified', 'available']),
  provinceDisplayState: z.enum(['empty', 'unidentified', 'available']),
});
export const dataStateSchema = z.enum([
  'available',
  'empty',
  'not_connected',
  'unsupported',
  'estimated',
  'unavailable',
]);
export type DataState = z.infer<typeof dataStateSchema>;
export type Row = Record<string, string | number | null | boolean>;
export interface LiekanReport {
  contractVersion: 2;
  website: { id: string; name: string; domain: string; siteNumber?: number | null };
  range: { startAt: number; endAt: number; timezone: string };
  states: { human: DataState; logs: DataState; catalog: DataState; goals: DataState };
  cards: Array<{
    key: string;
    label: string;
    value: number | string | null;
    unit?: string;
    detail?: string;
    state: DataState;
  }>;
  charts: Record<
    string,
    {
      labels: string[];
      series: Array<{ name: string; values: Array<number | null> }>;
      rows?: Record<string, unknown>[];
      state?: DataState;
    }
  >;
  tables: Record<string, Row[]>;
  insights: string[];
  meta: {
    snapshot?: {
      dataThrough: number;
      state: 'ready' | 'updating';
      intervalMs: number;
      updateError?: boolean;
    };
    population?: BrowserPopulation;
    trendPopulation?: BrowserPopulation;
    catalogVersion?: string;
    crawlerPageBots?: Array<{
      botId: string | null;
      name: string;
      type: string;
      productForm?: string;
    }>;
    crawlerEvidenceView?: {
      snapshot: string;
      policySnapshot: string;
      query: Record<string, unknown>;
    };
    crawlerMetrics?: {
      scope: CrawlerIdentityScope;
      version: 1 | null;
      population: string;
      timeBoundary: 'half_open' | 'legacy_inclusive';
    };
    geography?: {
      charts?: Record<string, GeographyDisplay[]>;
      tables?: Record<string, GeographyDisplay[]>;
      cards?: Record<string, GeographyDisplay>;
    };
    geographyCoverage?: GeographyCoverage;
    keywordSnapshot?: string;
    keywordReset?: boolean;
    keywordEngines?: string[];
    keywordHasGoals?: boolean;
    keywordReadAt?: number;
    demo: boolean;
    canManage: boolean;
    latestImportAt: string | null;
    ruleCount: number;
    crawlerClassification?: {
      mode: 'current' | 'legacy' | 'mixed';
      versions: number;
      legacyRequests: number;
      unclassifiedRequests: number;
    };
    aiCrawlerEnabled?: boolean;
    logsConfigured?: boolean;
    totalLogs?: number;
    page?: number;
    pageSize?: number;
    nextCursor?: string;
    previousCursor?: string;
    // 可分页明细表的序列化状态：键为表名（pagableTables 白名单），出现在哪个表
    // 就表示该表已按 pageSize 服务端切片，客户端不再本地分页。
    tablePages?: Record<string, { page: number; pageSize: number; total: number }>;
  };
}

const chartSchema = z.object({
  labels: z.array(z.string()),
  series: z.array(z.object({ name: z.string(), values: z.array(z.number().nullable()) })),
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
  state: dataStateSchema.optional(),
});
const geographyDisplaySchema = z.object({
  country: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  cityId: z.number().int().positive().nullable(),
});
export const chartIds = [
  'd1',
  'd2',
  'd3',
  'a1',
  'a2',
  'a3',
  'a4',
  'b1',
  'ap1',
  'pf1',
  'pf2',
  'h1',
  'h2',
  'h3',
  'g1',
  'g2',
  's1',
  's2',
  'se1',
  'se2',
  'c1',
  'f1',
  'f2',
  'f3',
] as const;
export const liekanReportSchema = z.object({
  contractVersion: z.literal(2),
  website: z.object({
    id: z.uuid(),
    name: z.string(),
    domain: z.string(),
    siteNumber: z.number().int().nullable().optional(),
  }),
  range: z.object({ startAt: z.number(), endAt: z.number(), timezone: z.string() }),
  states: z.object({
    human: dataStateSchema,
    logs: dataStateSchema,
    catalog: dataStateSchema,
    goals: dataStateSchema,
  }),
  cards: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      value: z.union([z.number(), z.string(), z.null()]),
      unit: z.string().optional(),
      detail: z.string().optional(),
      state: dataStateSchema,
    }),
  ),
  charts: z.object(
    Object.fromEntries(chartIds.map(id => [id, chartSchema])) as Record<
      (typeof chartIds)[number],
      typeof chartSchema
    >,
  ),
  tables: z.record(
    z.string(),
    z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  ),
  insights: z.array(z.string()),
  meta: z.object({
    snapshot: z
      .object({
        dataThrough: z.number(),
        state: z.enum(['ready', 'updating']),
        intervalMs: z.number(),
        updateError: z.boolean().optional(),
      })
      .optional(),
    population: browserPopulationSchema.optional(),
    trendPopulation: browserPopulationSchema.optional(),
    catalogVersion: z.uuid().optional(),
    crawlerPageBots: z
      .array(
        z.object({
          botId: z.string().nullable(),
          name: z.string(),
          type: z.string(),
          productForm: z.string().optional(),
        }),
      )
      .optional(),
    crawlerEvidenceView: z
      .object({
        snapshot: z.string(),
        policySnapshot: z.string(),
        query: z.record(z.string(), z.unknown()),
      })
      .optional(),
    crawlerMetrics: z
      .object({
        scope: crawlerIdentityScopeSchema,
        version: z.literal(1).nullable(),
        population: z.string(),
        timeBoundary: z.enum(['half_open', 'legacy_inclusive']),
      })
      .optional(),
    geography: z
      .object({
        charts: z.record(z.string(), z.array(geographyDisplaySchema)).optional(),
        tables: z.record(z.string(), z.array(geographyDisplaySchema)).optional(),
        cards: z.record(z.string(), geographyDisplaySchema).optional(),
      })
      .optional(),
    geographyCoverage: geographyCoverageSchema.optional(),
    keywordSnapshot: z.string().optional(),
    keywordReset: z.boolean().optional(),
    keywordEngines: z.array(z.string()).optional(),
    keywordHasGoals: z.boolean().optional(),
    keywordReadAt: z.number().optional(),
    demo: z.boolean(),
    canManage: z.boolean(),
    latestImportAt: z.string().nullable(),
    ruleCount: z.number().int().nonnegative(),
    crawlerClassification: z
      .object({
        mode: z.enum(['current', 'legacy', 'mixed']),
        versions: z.number().int().nonnegative(),
        legacyRequests: z.number().int().nonnegative(),
        unclassifiedRequests: z.number().int().nonnegative(),
      })
      .optional(),
    aiCrawlerEnabled: z.boolean().optional(),
    logsConfigured: z.boolean().optional(),
    totalLogs: z.number().int().nonnegative().optional(),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().optional(),
    nextCursor: z.string().optional(),
    previousCursor: z.string().optional(),
    tablePages: z
      .record(
        z.string(),
        z.object({
          page: z.number().int().positive(),
          pageSize: z.number().int().positive(),
          total: z.number().int().nonnegative(),
        }),
      )
      .optional(),
  }),
});
