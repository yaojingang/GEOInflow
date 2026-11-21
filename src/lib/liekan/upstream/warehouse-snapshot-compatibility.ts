import { z } from 'zod';
import { pageReportSchema } from '../contracts/page-report';
import type { ReportQuery } from '../contracts/query';
import type { WarehouseOverviewResult } from './page-report';
import { browserPopulationSchema } from '../contracts/browser-population';
import type { RetentionSnapshot } from './warehouse-retention-result';

export const currentSnapshotFormat = 3;
export const readableSnapshotFormats = [currentSnapshotFormat, 2];
const retention = z.object({
  kind: z.literal('retention'),
  dataThrough: z.number().finite(),
  population: browserPopulationSchema,
  rows: z.array(
    z.object({
      date: z.string(),
      day: z.number().int().nonnegative(),
      visitors: z.number().int().nonnegative().nullable(),
      returnVisitors: z.number().int().nonnegative().nullable(),
      percentage: z.number().min(0).max(100).nullable(),
    }),
  ),
});
export function adaptPreviousRetention(
  format: number,
  input: unknown,
): RetentionSnapshot | undefined {
  if (format !== 2) return;
  const parsed = retention.safeParse(input);
  if (parsed.success) return parsed.data as RetentionSnapshot;
}
const rankings = z.object({
  build: z.uuid(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  totals: z.record(z.string(), z.number().int().nonnegative()).optional(),
  pending: z.boolean().optional(),
  round: z.uuid().optional(),
});
const inlineRanking = z.object({
  table: z.enum(['topBody', 'visitorTopBody']),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
});
/** Format 2 uses the same metric semantics and public page contract. Validate
 * its payload and range; do not relabel persisted rows or invent missing fields. */
export function adaptPreviousSnapshot(
  format: number,
  input: unknown,
  parameters: ReportQuery,
  websiteId?: string,
): WarehouseOverviewResult | undefined {
  if (format !== 2) return;
  const parsed = pageReportSchema.safeParse(input);
  if (!parsed.success) return;
  const value = parsed.data;
  const cutoff = value.meta.snapshot?.dataThrough;
  // The saved range is the actual evaluated interval, clipped at the frozen
  // clock. Inclusive ranges end one millisecond before that clock; the newer
  // crawler metric contract uses a half-open interval.
  const expectedEnd = Math.min(
    parameters.endAt,
    cutoff - (parameters.crawlerMetricsVersion === 1 ? 0 : 1),
  );
  if (
    (websiteId && value.website.id !== websiteId) ||
    value.resource !== parameters.resource ||
    value.range.startAt !== parameters.startAt ||
    value.range.endAt !== expectedEnd ||
    value.range.timezone !== parameters.timezone ||
    !Number.isFinite(cutoff)
  )
    return;
  const saved = input as WarehouseOverviewResult;
  const artifact = rankings.safeParse(saved.rankings);
  const inline = inlineRanking.safeParse(saved.overviewRanking);
  return {
    ...value,
    ...(artifact.success && { rankings: artifact.data }),
    ...(inline.success && { overviewRanking: inline.data }),
  } as WarehouseOverviewResult;
}
