import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { parseReportQuery } from '../contracts/query';
import { analysisVersions } from './analysis-rollups-db';
import { reportSnapshot, query } from './server';
import { dashboardWindow } from './dashboard-snapshot-model';

export const FIRST_PAGE_BUDGET_MS = 750;
export function firstPageRange(input: Record<string, unknown>, now = Date.now()) {
  const parsed = parseReportQuery(input);
  if (!parsed.success || input.refresh === '1') return undefined;
  const p = parsed.data;
  if (!['ai/overview', 'ai/bots', 'ai/pages', 'ai/preference'].includes(p.resource)) return;
  if (p.crawlerMetricsVersion !== 1 || p.endAt <= p.startAt || p.endAt - p.startAt > 90 * 86400000)
    return;
  const end = Math.min(p.endAt, dashboardWindow('feature:page-report', p, now).through);
  let start = p.startAt;
  if (p.resource === 'ai/bots') start -= end - start;
  if (p.resource === 'ai/overview') {
    const [year, month] = formatInTimeZone(end - 1, p.timezone, 'yyyy-MM')
      .split('-')
      .map(Number);
    const day = new Date(Date.UTC(year, month - 6, 1)).toISOString().slice(0, 10);
    start = Math.min(start, +fromZonedTime(`${day}T00:00:00`, p.timezone));
  }
  return { start: new Date(start), end: new Date(end) };
}

/** Inspect bounded physical gaps before expanding the existing reporting/quality views. */
export async function canReadFirstPage(
  websiteId: string,
  input: Record<string, unknown>,
  deadline: number,
) {
  const range = firstPageRange(input);
  if (!range || +range.end <= +range.start) return false;
  return reportSnapshot(async () => {
    const { getQuerySnapshot } = await import('./query-snapshot');
    const versions = await analysisVersions(getQuerySnapshot() as any, websiteId);
    for (const [family, table, time] of [
      ['log', 'liekan_log', 'created_at'],
      ['visit', 'website_event', 'created_at'],
    ] as const) {
      const factTables =
        family === 'log'
          ? ['liekan_analysis_log', 'liekan_analysis_path']
          : [
              'liekan_analysis_visit',
              'liekan_analysis_browser_visit',
              'liekan_analysis_browser_path',
            ];
      const physicalFacts = factTables
        .map(
          table => `SELECT 1 FROM covered c CROSS JOIN LATERAL(
        SELECT 1 FROM ${table} f WHERE f.website_id=$1::uuid AND f.generation=c.generation
        AND f.bucket>=c.bucket AND f.bucket<c.bucket_end LIMIT 250001) physical`,
        )
        .join(' UNION ALL ');
      const [bounds] = await query<{ facts: string; raw: number }>(
        `WITH covered AS MATERIALIZED (
          SELECT m.bucket,m.bucket_end,m.generation FROM liekan_analysis_manifest m
          JOIN liekan_analysis_site s USING(website_id,epoch)
          WHERE m.website_id=$1::uuid AND m.family=$4 AND s.mode='live'
           AND m.bucket>=$2 AND m.bucket_end<=$3 AND m.versions=$5::jsonb
           AND (m.family<>'log' OR m.path_complete)
           AND m.fingerprint=liekan_analysis_fingerprint(m.website_id,m.epoch,m.family,m.bucket,m.bucket_end)
        ), facts AS (${physicalFacts}), spans AS(SELECT range_agg(tstzrange(bucket,bucket_end,'[)')) AS covered FROM covered),
        gaps AS(SELECT lower(span) AS starts,upper(span) AS ends FROM spans,
          unnest(tstzmultirange(tstzrange($2,$3,'[)'))-coalesce(covered,'{}'::tstzmultirange)) span)
        SELECT (SELECT count(*)::text FROM(SELECT 1 FROM facts LIMIT 250001) bounded_facts) AS facts,
          (SELECT count(*)::int FROM (SELECT 1 FROM gaps g CROSS JOIN LATERAL (
           SELECT 1 FROM (TABLE ${table}) r WHERE r.website_id=$1::uuid
           AND r.${time}>=g.starts AND r.${time}<g.ends LIMIT 20001
          ) physical LIMIT 20001) raw) AS raw`,
        websiteId,
        range.start,
        range.end,
        family,
        JSON.stringify(versions),
      );
      if (BigInt(bounds.facts) > 250000n || bounds.raw > 20000) return false;
    }
    return true;
  }, deadline);
}
