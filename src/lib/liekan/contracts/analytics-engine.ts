import { z } from 'zod';

export const analyticsEngineActionSchema = z
  .object({
    action: z.enum(['check', 'prepare', 'verify', 'enable', 'disable', 'pause', 'resume', 'retry']),
    requestId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    locale: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
  })
  .strict();
export type AnalyticsEngineAction = z.infer<typeof analyticsEngineActionSchema>;
export const analyticsEngineStatusSchema = z.object({
  nextCursor: z.uuid().nullable().optional(),
  configured: z.boolean(),
  supported: z.boolean(),
  connection: z.string().nullable(),
  enabled: z.boolean(),
  syncing: z.boolean(),
  revision: z.number().int(),
  checkedAt: z.string().nullable(),
  version: z.string().nullable(),
  healthy: z.boolean(),
  workerAt: z.string().nullable(),
  error: z.string().nullable(),
  sites: z.array(
    z.object({
      websiteId: z.uuid(),
      name: z.string(),
      completed: z.string(),
      pending: z.string(),
      failed: z.string(),
      rows: z.string(),
      rangeStart: z.string().nullable(),
      rangeEnd: z.string().nullable(),
      lastPublishedAt: z.string().nullable(),
      purgePending: z.boolean(),
    }),
  ),
});
export interface AnalyticsEngineStatus {
  nextCursor?: string | null;
  configured: boolean;
  supported: boolean;
  connection: string | null;
  enabled: boolean;
  syncing: boolean;
  revision: number;
  checkedAt: string | null;
  version: string | null;
  healthy: boolean;
  workerAt: string | null;
  error: string | null;
  sites: {
    websiteId: string;
    name: string;
    completed: string;
    pending: string;
    failed: string;
    rows: string;
    rangeStart: string | null;
    rangeEnd: string | null;
    lastPublishedAt: string | null;
    purgePending: boolean;
  }[];
}
