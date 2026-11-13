import { z } from 'zod';
import { reportQuery } from './query';
import type { LiekanReport } from './report';
import { liekanReportSchema } from './report';

export const logBoundarySchema = z.string().regex(/^[a-f0-9]{64}$/);
export const logReadQuery = reportQuery
  .pick({
    startAt: true,
    endAt: true,
    timezone: true,
    page: true,
    cursor: true,
    seek: true,
    filter: true,
    search: true,
    crawlerIdentityScope: true,
    crawlerMetricsVersion: true,
    refresh: true,
  })
  .extend({ readBoundary: logBoundarySchema.optional() });
export const logCountQuery = logReadQuery.extend({ readBoundary: logBoundarySchema });
export type LogReadQuery = z.output<typeof logReadQuery>;
export const logCountSchema = z.object({
  readBoundary: logBoundarySchema,
  total: z.number().int().nonnegative(),
});
export type LogCount = z.infer<typeof logCountSchema>;
export const logSummarySchema = z.object({
  readBoundary: logBoundarySchema,
  evidence: z
    .object({ query: z.record(z.string(), z.unknown()), policySnapshot: logBoundarySchema })
    .optional(),
  cards: liekanReportSchema.shape.cards,
  tables: liekanReportSchema.shape.tables,
  states: liekanReportSchema.shape.states.pick({ logs: true, catalog: true }),
  meta: liekanReportSchema.shape.meta.pick({
    latestImportAt: true,
    ruleCount: true,
    crawlerClassification: true,
  }),
});
export type LogSummary = z.infer<typeof logSummarySchema> & { cards: LiekanReport['cards'] };
