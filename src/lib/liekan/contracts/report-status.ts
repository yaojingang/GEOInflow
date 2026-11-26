import { z } from 'zod';
import { analysisJobSchema } from './analysis-acceleration';
import type { UseQueryResult } from '@tanstack/react-query';

export const warehouseReportNoValidSnapshot = 'warehouse-report-no-valid-snapshot';

export function invalidatesRetainedRead(error: unknown) {
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  const { status } = error;
  return (
    (typeof status === 'number' && [401, 403, 404, 409, 410].includes(status)) ||
    ('code' in error && error.code === warehouseReportNoValidSnapshot)
  );
}

/** A completed HTTP read with no published result. It contains no synthetic metrics. */
export const reportPreparingSchema = z.object({
  status: z.literal('preparing'),
  analysisJob: analysisJobSchema.optional(),
});
export type ReportPreparing = z.infer<typeof reportPreparingSchema>;
export function isReportPreparing(value: unknown): value is ReportPreparing {
  return !!value && typeof value === 'object' && 'status' in value && value.status === 'preparing';
}

/** Keep the status in the query cache, while metric consumers receive only real reports. */
export function publishedReport<T>(value: T | ReportPreparing): T | undefined {
  return isReportPreparing(value) ? undefined : value;
}

/** The owning view renders preparing separately; existing metric widgets never
 * receive a status envelope. refetch remains a status read and is projected too. */
export function publishedReportQuery<T>(
  query: UseQueryResult<T | ReportPreparing, any>,
): UseQueryResult<T, any> {
  return {
    ...query,
    data: publishedReport(query.data),
    refetch: async options => publishedReportQuery(await query.refetch(options)),
  } as UseQueryResult<T, any>;
}
