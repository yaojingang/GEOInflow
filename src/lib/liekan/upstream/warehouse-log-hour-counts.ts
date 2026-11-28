import { createHash } from 'node:crypto';
import type { AnalysisRead } from '../warehouse/analysis-context';
import { staticRequestExtensionPattern } from './log-content-boundary';

export const logCountPattern = `(?i)${staticRequestExtensionPattern}`;
export const logCountExpressions =
  'countIf(NOT match(path,{staticPattern:String})) AS requests,countIf(status>=400) AS abnormal';
export const logCountVersion = createHash('sha256')
  .update(JSON.stringify([logCountExpressions, logCountPattern]))
  .digest('hex');

/** UTC buckets form a disjoint partition even across local midnight and DST.
 * Boundaries are milliseconds, but logs have microseconds: the final instant
 * belongs to the original inclusive query, never round it up to the next ms. */
export async function countLogWindow(
  model: AnalysisRead | undefined,
  start: number,
  end: number,
  read: (
    start: number,
    end: number,
    endExclusive: boolean,
  ) => Promise<{ requests: number; abnormal: number }>,
) {
  if (!model || model.logCounts?.version !== logCountVersion) return read(start, end, false);
  let cursor = start,
    requests = 0,
    abnormal = 0;
  for (const [hour, build, rows] of model.log) {
    const from = hour * 1000,
      to = from + 3600000;
    if (from < cursor || to > end) continue;
    const counts = rows === 0 ? ([build, 0, 0] as const) : model.logCounts.hours[hour];
    if (!counts || counts[0] !== build) continue;
    if (
      counts.length !== 3 ||
      !counts
        .slice(1)
        .every(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= rows)
    )
      throw new Error('warehouse-hour-counter-invalid');
    if (cursor < from) {
      const gap = await read(cursor, from, true);
      requests += gap.requests;
      abnormal += gap.abnormal;
    }
    requests += counts[1];
    abnormal += counts[2];
    cursor = to;
  }
  const tail = await read(cursor, end, false);
  requests += tail.requests;
  abnormal += tail.abnormal;
  if (!Number.isSafeInteger(requests) || !Number.isSafeInteger(abnormal))
    throw new Error('warehouse-counter-out-of-range');
  return { requests, abnormal };
}
