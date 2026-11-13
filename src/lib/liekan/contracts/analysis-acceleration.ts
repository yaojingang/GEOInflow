import { z } from 'zod';
export const analysisJobStatusSchema = z.enum([
  'queued',
  'running',
  'ready',
  'failed',
  'invalidated',
  'expired',
]);
export const analysisJobSchema = z.object({
  id: z.uuid(),
  websiteId: z.uuid(),
  status: analysisJobStatusSchema,
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  generatedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
  errorCode: z.string().nullable(),
  retryAfterMs: z.number(),
  resultUrl: z.string(),
});
export type AnalysisJob = z.infer<typeof analysisJobSchema>;
export const analysisAcceptedSchema = z.object({
  analysisJob: analysisJobSchema,
  previousResult: z.unknown().optional(),
});
export type AnalysisAccepted = z.infer<typeof analysisAcceptedSchema>;
export const analysisBuildInputSchema = z
  .strictObject({
    preset: z.enum(['common', 'custom', 'retained']).default('common'),
    startAt: z.number().int().min(0).optional(),
    endAt: z.number().int().min(0).optional(),
    timezone: z.string().min(1).max(80).default('Asia/Shanghai'),
    locale: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
    requestId: z.uuid(),
    expectedRevision: z.number().int().min(0),
  })
  .refine(
    v => v.preset !== 'custom' || (v.startAt != null && v.endAt != null && v.startAt < v.endAt),
    'Invalid custom range',
  );
export const analysisActionSchema = z.strictObject({
  action: z.enum(['pause', 'resume', 'retry', 'disable', 'enable']),
  buildId: z.uuid().optional(),
  requestId: z.uuid(),
  expectedRevision: z.number().int().min(0),
});
export type AnalysisBuildInput = z.infer<typeof analysisBuildInputSchema>;
export interface AnalysisBuildDto {
  id: string;
  status:
    | 'queued'
    | 'running'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'invalidated'
    | 'capacity_limited';
  progress: number;
  completedUnits: string;
  totalUnits: string;
  rangeStart: string;
  rangeEnd: string;
  timezone: string;
  locale: 'zh-CN' | 'en-US';
  errorCode: string | null;
  revision: number;
  updatedAt: string;
}
export interface AnalysisStatusDto {
  warmup?: {
    unregistered?: number;
    expected: number;
    ready: number;
    preparing: number;
    oldestPendingAt: string | null;
  };
  websiteId: string;
  supported: boolean;
  mode: 'live' | 'disabled';
  epoch: string;
  revision: number;
  captureFrom: string;
  builds: AnalysisBuildDto[];
  coverage: {
    family: 'log' | 'visit';
    rangeStart: string;
    rangeEnd: string;
    current: boolean;
    rowCount: string;
  }[];
  expansion: { path: boolean; visit: boolean };
  capacity: { siteBytes: string; globalBytes: string; siteLimit: number; globalLimit: number };
}
export interface AnalysisWebsiteList {
  supported: boolean;
  websites: { id: string; name: string; domain: string; mode: string }[];
  nextCursor: string | null;
}
export const analysisBuildSchema = z.object({
  id: z.uuid(),
  status: z.enum([
    'queued',
    'running',
    'paused',
    'completed',
    'failed',
    'invalidated',
    'capacity_limited',
  ]),
  progress: z.number().min(0).max(100),
  completedUnits: z.string(),
  totalUnits: z.string(),
  rangeStart: z.string(),
  rangeEnd: z.string(),
  timezone: z.string(),
  locale: z.enum(['zh-CN', 'en-US']),
  errorCode: z.string().nullable(),
  revision: z.number(),
  updatedAt: z.string(),
});
export const analysisStatusSchema = z.object({
  warmup: z
    .object({
      unregistered: z.number().int().nonnegative().optional(),
      expected: z.number().int().nonnegative(),
      ready: z.number().int().nonnegative(),
      preparing: z.number().int().nonnegative(),
      oldestPendingAt: z.string().nullable(),
    })
    .optional(),
  expansion: z.object({ path: z.boolean(), visit: z.boolean() }),
  websiteId: z.uuid(),
  supported: z.boolean(),
  mode: z.enum(['live', 'disabled']),
  epoch: z.string(),
  revision: z.number(),
  captureFrom: z.string(),
  builds: z.array(analysisBuildSchema),
  coverage: z.array(
    z.object({
      family: z.enum(['log', 'visit']),
      rangeStart: z.string(),
      rangeEnd: z.string(),
      current: z.boolean(),
      rowCount: z.string(),
    }),
  ),
  capacity: z.object({
    siteBytes: z.string(),
    globalBytes: z.string(),
    siteLimit: z.number(),
    globalLimit: z.number(),
  }),
});
export const analysisWebsiteListSchema = z.object({
  supported: z.boolean(),
  websites: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      domain: z.string().nullable(),
      mode: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
