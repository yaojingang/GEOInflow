import { BROWSER_RISK_VERSION, BROWSER_RISK_WINDOW_LIMIT } from '../traffic-quality/behavior';
import { warehouseTime } from '../warehouse/fact-input';
import { v2Tables } from '../warehouse-v2/index';
import {
  warehouseReportMetadata,
  warehouseReportQuery,
  withinWarehouseReport,
} from './warehouse-report-snapshot';

const asDate = (v: string) => new Date(v.includes('T') ? v : `${v.replace(' ', 'T')}Z`);

export async function warehouseRiskWindowEvents(site: string, end: Date) {
  return withinWarehouseReport(async () => {
    const rows = await warehouseReportQuery<any>(
      site,
      `SELECT
        event_id, session_id, visit_id, event_type, url_path, received_at,
        collection_source AS source, classification, identity_available,
        is_eligible AS admissible
      FROM ${v2Tables.browserEvents}
      WHERE website_id = {wh_site:UUID} AND epoch = {wh_epoch:UInt64} AND _deleted = 0
        AND received_at > {riskStart:DateTime64(6,'UTC')} AND received_at <= {riskEnd:DateTime64(6,'UTC')}
      ORDER BY received_at, event_id
      LIMIT {riskLimit:UInt32}`,
      {
        riskStart: warehouseTime(new Date(+end - 300000)),
        riskEnd: warehouseTime(end),
        riskLimit: BROWSER_RISK_WINDOW_LIMIT + 1,
      },
    );
    return rows.map(r => ({
      ...r,
      received_at: asDate(r.received_at),
      observed_at: asDate(r.received_at),
    }));
  });
}

export async function processWarehouseBrowserRisk() {
  // Warehouse v2 computes risk summaries on-demand without v1 task queues.
}

export async function warehouseBrowserRiskReport(site: string, parameters: URLSearchParams) {
  const { parseQualityRange, qualityReadTransaction } = await import('./traffic-quality');
  const { warehouseQualityTotals } = await import('./warehouse-traffic-quality');
  const riskParameters = new URLSearchParams(parameters);
  riskParameters.delete('path');
  const range = parseQualityRange(riskParameters);
  return withinWarehouseReport(async () => {
    const metadata = await warehouseReportMetadata(site);
    const { state, coverage } = await qualityReadTransaction(async tx => {
      const [state] = await tx.$queryRawUnsafe(
        'SELECT started_at AS "startedAt",computed_at AS "computedAt",next_window AS "nextWindow",error_code AS "errorCode",rule_version AS "ruleVersion" FROM liekan_browser_risk_state WHERE website_id=$1::uuid',
        site,
      );
      const [coverage] = await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS windows,count(*) FILTER(WHERE coverage='partial')::int AS "partialWindows",min(window_end) AS "firstWindow",max(window_end) AS "lastWindow"
        FROM liekan_browser_risk_window WHERE website_id=$1::uuid AND window_end BETWEEN $2 AND $3 AND rule_version=$4 AND epoch=$5::bigint`,
        site,
        new Date(range.startAt),
        new Date(range.endAt),
        BROWSER_RISK_VERSION,
        String(metadata.population.epoch),
      );
      return { state, coverage };
    });
    const [impact] = await warehouseReportQuery<{ flaggedPV: string; remainingUV: string }>(
      site,
      `SELECT
        toString(countIf(is_risk_flagged)) AS flaggedPV,
        toString(uniqExactIf(session_id, NOT is_risk_flagged)) AS remainingUV
      FROM ${v2Tables.browserEvents}
      WHERE website_id = {wh_site:UUID} AND epoch = {wh_epoch:UInt64} AND _deleted = 0
        AND event_type NOT IN (2, 5) AND is_eligible
        AND received_at >= {riskStart:DateTime64(6,'UTC')} AND received_at <= {riskEnd:DateTime64(6,'UTC')}`,
      {
        riskStart: warehouseTime(new Date(range.startAt)),
        riskEnd: warehouseTime(new Date(range.endAt)),
      },
    );
    const totals = await warehouseQualityTotals(site, range);
    const flaggedPV = Number(impact?.flaggedPV ?? 0);
    const remainingUV = Number(impact?.remainingUV ?? 0);
    return {
      available: true,
      mode: 'observe',
      ruleVersion: BROWSER_RISK_VERSION,
      state: state || null,
      coverage,
      findings: [],
      impact: {
        includedPV: totals.includedPV,
        includedUV: totals.includedUV,
        flaggedPV,
        fullyExcludedUV: totals.includedUV === null ? null : totals.includedUV - remainingUV,
      },
      timeBasis: 'server-received',
      range: { startAt: range.startAt, endAt: range.endAt },
      retentionDays: 30,
    };
  });
}
