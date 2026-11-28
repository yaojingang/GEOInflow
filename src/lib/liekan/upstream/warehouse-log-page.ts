import type { AnalysisWindow } from '../warehouse/analysis-context';

const hour = 3600000;

/** Disjoint, hour-aligned windows in output order. Empty/sparsely matching
 * ranges grow geometrically, so they do not cause one round trip per hour.
 * Bounds are physical candidate timestamps, never a verdict or a row limit.
 * The caller must resolve canonical rows and ALL filters before each LIMIT. */
export async function readLogPageWindows<T>(
  range: AnalysisWindow,
  candidates: { firstHour: number; lastHour: number } | undefined,
  limit: number,
  ascending: boolean,
  cursorTime: string | undefined,
  read: (window: AnalysisWindow, remaining: number) => Promise<T[]>,
): Promise<T[]> {
  if (!candidates) return [];
  let start = Math.max(range.start, candidates.firstHour * 1000);
  let end = Math.min(range.end, candidates.lastHour * 1000 + hour);
  let endExclusive = end < range.end || !!range.endExclusive;
  if (cursorTime) {
    // Only prune whole hours; Date's millisecond precision must never replace
    // the original DateTime64(6), ID tuple predicate used by the SQL reader.
    const cursorHour = Math.floor(Date.parse(cursorTime.replace(' ', 'T') + 'Z') / hour) * hour;
    if (ascending) start = Math.max(start, cursorHour);
    else if (cursorHour + hour < end) {
      end = cursorHour + hour;
      endExclusive = true;
    }
  }
  const rows: T[] = [];
  let width = 1;
  while (start < end || (start === end && !endExclusive)) {
    const window = ascending
      ? { start, end: Math.min(end, (Math.floor(start / hour) + width) * hour) }
      : {
          start: Math.max(
            start,
            (Math.floor((end - (endExclusive ? 1 : 0)) / hour) - width + 1) * hour,
          ),
          end,
        };
    const exclusive = window.end < end || endExclusive;
    const batch = await read({ ...window, endExclusive: exclusive }, limit - rows.length);
    rows.push(...batch);
    if (rows.length >= limit) return rows.slice(0, limit);
    if (ascending) {
      if (window.end === end) break;
      start = window.end;
    } else {
      end = window.start;
      endExclusive = true;
    }
    width *= 2;
  }
  return rows;
}
