import { AsyncLocalStorage } from 'node:async_hooks';

export type AnalysisKind = 'browser' | 'log';
export type AnalysisBucket = [hour: number, build: string, rows: number, visits: number];
export type AnalysisRead = {
  site: string;
  control: string;
  publication?: Record<AnalysisKind, string>;
  browser: AnalysisBucket[];
  log: AnalysisBucket[];
};
// Completeness is a scoped runtime proof, never a persisted checkpoint flag.
// Nested/unqualified reads must establish their own proof for their own buckets.
const context = new AsyncLocalStorage<{
  value: AnalysisRead | undefined;
  complete: ReadonlySet<AnalysisKind>;
  verified: ReadonlySet<AnalysisKind>;
  windows: Partial<Record<AnalysisKind, AnalysisWindow>>;
}>();
export const withAnalysisRead = <T>(
  value: AnalysisRead | undefined,
  work: () => T,
  complete: AnalysisKind[] = [],
  verified: AnalysisKind[] = [],
  windows: Partial<Record<AnalysisKind, AnalysisWindow>> = {},
) =>
  context.run({ value, complete: new Set(complete), verified: new Set(verified), windows }, work);
export const currentAnalysisRead = () => context.getStore()?.value;
export const withoutAnalysisRead = <T>(work: () => T) => context.run(undefined, work);
export function analysisReadParameters() {
  const value = currentAnalysisRead();
  return value
    ? {
        ar_control: value.control,
        ar_browser_hours: value.browser.map(b => b[0]),
        ar_browser_builds: value.browser.map(b => b[1]),
        ar_log_hours: value.log.map(b => b[0]),
        ar_log_builds: value.log.map(b => b[1]),
      }
    : {};
}
/** Only verified complete hours replace facts. Uncovered/partial/older windows
 * retain the authoritative relation, including cross-day visit anchors. */
export function analysisReadRelation(
  kind: AnalysisKind,
  columns: string[],
  fallback: (coveredHoursParameter?: string) => string,
  qualified: boolean | '_qualified_event' = false,
) {
  const value = currentAnalysisRead();
  if (!value?.[kind].length) return;
  const hours = `{ar_${kind}_hours:Array(Int64)}`;
  const selected = columns.map(c => `"${c}"`).join(',');
  const model = `SELECT ${selected} FROM warehouse_analysis_${kind}_v1
    WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND _control={ar_control:String}
      AND (_hour,_build) IN arrayZip(${hours},{ar_${kind}_builds:Array(UUID)}) ${qualified ? `AND ${qualified === true ? '_qualified' : qualified}` : ''}`;
  if (context.getStore()?.complete.has(kind)) return `(${model})`;
  return `(${model}
    UNION ALL SELECT ${selected} FROM ${withoutAnalysisRead(() => fallback(`ar_${kind}_hours`))}
      WHERE isNull(created_at) OR toInt64(toUnixTimestamp(toStartOfHour(created_at))) NOT IN ${hours})`;
}

export type AnalysisWindow = { start: number; end: number; endExclusive?: boolean };
/** A bounded read needs verified coverage of its own hours, not every timestamp
 * ever collected. Cross-window dependencies must already be materialized by the
 * caller's model (for example, visit entry and geography). */
export function analysisWindowRelation(
  kind: AnalysisKind,
  columns: string[],
  window: AnalysisWindow | undefined,
  qualified: boolean | '_qualified_event' = false,
) {
  if (!window || !context.getStore()?.verified.has(kind)) return;
  const { start, end, endExclusive } = window;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start ||
    (endExclusive && end === start)
  )
    return;
  const first = Math.floor(start / 3600000) * 3600;
  const last = Math.floor((end - (endExclusive ? 1 : 0)) / 3600000) * 3600;
  const buckets = currentAnalysisRead()?.[kind] ?? [];
  const covered = new Set(buckets.map(b => b[0]));
  const proof = context.getStore()?.windows[kind];
  const withinProvedWindow = proof && start >= proof.start && end <= proof.end;
  if (!withinProvedWindow) {
    if ((last - first) / 3600 + 1 > covered.size) return;
    for (let hour = first; hour <= last; hour += 3600) if (!covered.has(hour)) return;
  }
  return `(SELECT ${columns.map(c => `"${c}"`).join(',')}
    FROM warehouse_analysis_${kind}_v1
    WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND _control={ar_control:String}
      AND (_hour,_build) IN arrayZip({ar_${kind}_hours:Array(Int64)},{ar_${kind}_builds:Array(UUID)})
      AND _hour>=${first} AND _hour<=${last}
      AND created_at>=fromUnixTimestamp64Milli(${start})
      AND created_at${endExclusive ? '<' : '<='}fromUnixTimestamp64Milli(${end})
      ${qualified ? `AND ${qualified === true ? '_qualified' : qualified}` : ''})`;
}
