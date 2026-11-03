import { warehouseTime } from '../warehouse/fact-input';
import { factRelation } from '../warehouse/read';
import { repairedQualityRelation, websiteEventRelation } from '../warehouse/reporting-relations';
import { populationFromRow } from './browser-population';
import {
  warehouseReportMetadata,
  warehouseReportQuery,
  withinWarehouseReport,
} from './warehouse-report-snapshot';

/** Qualified browser identities require an accepted session in the same website. */
export function warehouseBrowserPopulationSql(halfOpen = false) {
  return `WITH population AS (
      SELECT e.event_id AS event_id,e.session_id AS session_id,e.event_type AS event_type,
        (e.event_type IN(3,4) OR (env.scope='browser' AND env.identity_available AND q.source='browser' AND q.classification='browser' AND present.session_id IS NOT NULL)) AS qualified,
        env.identity_version AS identity_version,q.rule_version AS rule_version,toString(q.catalog_version) AS catalog_version
      FROM ${websiteEventRelation('observed')} e
      LEFT JOIN ${factRelation('session', { columns: ['website_id', 'session_id'] })} present ON present.website_id=e.website_id AND present.session_id=e.session_id
      LEFT JOIN ${factRelation('liekan_event_environment')} env ON env.website_id=e.website_id AND env.event_id=e.event_id
      LEFT JOIN ${repairedQualityRelation()} q ON q.website_id=e.website_id AND q.event_id=e.event_id
      WHERE e.created_at>={start:DateTime64(6,'UTC')} AND e.created_at${halfOpen ? '<' : '<='}{end:DateTime64(6,'UTC')}
    ) SELECT count() AS eligibleEvents,countIf(qualified) AS qualifiedEvents,
      countIf(event_type IN(1,3,4)) AS eligiblePV,countIf(event_type IN(1,3,4) AND qualified) AS qualifiedPV,
      uniqExactIf(session_id,event_type IN(1,3,4) AND qualified) AS qualifiedVisitors,
      arraySlice(arraySort(groupUniqArray(identity_version)),1,33) AS identityVersions,
      arraySlice(arraySort(groupUniqArrayIf(identity_version,event_type IN(1,3,4) AND qualified AND identity_version IS NOT NULL)),1,33) AS qualifiedIdentityVersions,
      arraySlice(arraySort(groupUniqArray(rule_version)),1,33) AS ruleVersions,
      arraySlice(arraySort(groupUniqArray(catalog_version)),1,33) AS catalogVersions FROM population`;
}

export async function warehouseBrowserPopulation(
  id: string,
  start: Date,
  end: Date,
  timezone = 'UTC',
  halfOpen = false,
) {
  return withinWarehouseReport(async () => {
    const metadata = await warehouseReportMetadata(id);
    const [row] = await warehouseReportQuery<any>(id, warehouseBrowserPopulationSql(halfOpen), {
      start: warehouseTime(start),
      end: warehouseTime(end),
    });
    return {
      ...populationFromRow(
        { ...metadata.population, ...row, metricScope: 'qualified-browser' },
        { startAt: +start, endAt: +end, timezone, ...(halfOpen ? { endExclusive: true } : {}) },
      ),
      resourceId: id,
    };
  });
}
