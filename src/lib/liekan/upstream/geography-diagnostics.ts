import { warehouseEnabled } from '../warehouse/runtime';
import { factRelation } from '../warehouse/read';
import { warehouseTime } from '../warehouse/fact-input';
import { warehouseReportQuery } from './warehouse-report-snapshot';
import { identityUsable } from '../contracts/browser-population';
import { geographyAttribution } from '@/lib/detect';
import clickhouse from '@/lib/clickhouse';
import { query, LiekanError, reportSnapshot } from './server';
import { getHumanFacts } from './analytics';
import { geographyCoverage, geographyVersion } from '../contracts/geography';
import { GEOGRAPHY_ANCHOR_VERSION, GEOGRAPHY_RULE_VERSION } from '../geography/evidence';
import { geographyBundle, geographyRuntimeStatus } from '../geography/bundle';
import { ipConfigurationStatus } from '@/lib/ip';
import { z } from 'zod';
import { analyticsGate } from './analytics-budget';
export const geographyDiagnosticQuery = z
  .object({
    startAt: z.coerce.number().int().nonnegative().optional(),
    endAt: z.coerce.number().int().nonnegative().optional(),
    timezone: z.string().max(100).optional(),
  })
  .strict();

export async function geographyDiagnostics(id: string, input: URLSearchParams) {
  if (clickhouse.enabled)
    return {
      available: false,
      reason: '事件地域证据当前支持 PostgreSQL；ClickHouse 保留原有地域查询。',
    };
  const p = geographyDiagnosticQuery.safeParse(Object.fromEntries(input));
  if (!p.success) throw new LiekanError('地域诊断参数无效');
  const endAt = p.data.endAt ?? Date.now(),
    startAt = p.data.startAt ?? endAt - 30 * 86400000,
    timezone = p.data.timezone || 'Asia/Shanghai';
  if (endAt < startAt || endAt - startAt > 366 * 86400000 || endAt > Date.now() + 86400000)
    throw new LiekanError('地域诊断日期范围无效');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    throw new LiekanError('时区无效');
  }
  await geographyBundle();
  await geographyAttribution();
  const deadline = Date.now() + 60000;
  return analyticsGate.run(
    () =>
      reportSnapshot(async () => {
        const facts = await getHumanFacts(
          id,
          new Date(startAt),
          new Date(endAt),
          timezone,
          ['geo'],
          { rows: 100000, bytes: 50 * 1024 * 1024 },
        );
        const evidence = warehouseEnabled()
          ? await warehouseReportQuery(
              id,
              `SELECT coalesce(g.precision,'historical_unknown') AS precision,coalesce(g.reason,'historical_evidence_missing') AS reason,
          coalesce(g.source,'historical_unknown') AS source,coalesce(g.trust,'historical_unknown') AS trust,coalesce(g.ip_family,'missing') AS ipFamily,
          g.data_version AS dataVersion,g.rule_version AS ruleVersion,JSONExtract(coalesce(g.shadow,'{}'),'precision','Nullable(String)') AS shadowPrecision,
          JSONExtract(coalesce(g.shadow,'{}'),'reason','Nullable(String)') AS shadowReason,toUInt32(count()) AS events
          FROM ${factRelation('website_event')} e LEFT JOIN ${factRelation('liekan_event_geography')} g ON g.event_id=e.event_id AND g.website_id=e.website_id
          WHERE e.created_at BETWEEN {start:DateTime64(6)} AND {end:DateTime64(6)} GROUP BY precision,reason,source,trust,ipFamily,dataVersion,ruleVersion,shadowPrecision,shadowReason ORDER BY events DESC`,
              { start: warehouseTime(new Date(startAt)), end: warehouseTime(new Date(endAt)) },
            )
          : await query(
              `SELECT coalesce(g.precision,'historical_unknown') AS precision,coalesce(g.reason,'historical_evidence_missing') AS reason,
        coalesce(g.source,'historical_unknown') AS source,coalesce(g.trust,'historical_unknown') AS trust,
        coalesce(g.ip_family,'missing') AS "ipFamily",g.data_version AS "dataVersion",g.rule_version AS "ruleVersion",
        g.shadow->>'precision' AS "shadowPrecision",g.shadow->>'reason' AS "shadowReason",count(*)::int AS events
       FROM liekan_raw_website_event e LEFT JOIN liekan_event_geography g ON g.event_id=e.event_id AND g.website_id=e.website_id
       WHERE e.website_id=$1::uuid AND e.created_at BETWEEN $2::timestamptz AND $3::timestamptz
       GROUP BY 1,2,3,4,5,6,7,8,9 ORDER BY events DESC`,
              id,
              new Date(startAt),
              new Date(endAt),
            );
        const ingress = warehouseEnabled()
          ? (
              await warehouseReportQuery<any>(
                id,
                `SELECT reason,sum(g.count) AS count FROM ${factRelation('liekan_geography_ingress')} g
          WHERE bucket BETWEEN {start:DateTime64(6)} AND {end:DateTime64(6)} GROUP BY reason`,
                { start: warehouseTime(new Date(startAt)), end: warehouseTime(new Date(endAt)) },
              )
            ).map(row => ({ ...row, count: Number(row.count) }))
          : await query(
              `SELECT reason,sum(count)::float8 AS count FROM liekan_geography_ingress WHERE website_id=$1::uuid AND bucket BETWEEN $2::timestamptz AND $3::timestamptz GROUP BY reason`,
              id,
              new Date(startAt),
              new Date(endAt),
            );
        return {
          available: true,
          ingress,
          range: { startAt, endAt, timezone },
          coverage: identityUsable(facts.totals.population)
            ? geographyCoverage(facts.geo, facts.totals.visits)
            : null,
          population: facts.totals.population,
          evidence,
          versions: {
            dictionary: geographyVersion,
            rule: GEOGRAPHY_RULE_VERSION,
            anchor: GEOGRAPHY_ANCHOR_VERSION,
          },
          runtime: geographyRuntimeStatus(),
          configuration: ipConfigurationStatus(),
        };
      }, deadline),
    deadline,
  );
}
