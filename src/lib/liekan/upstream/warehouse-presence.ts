import { crawlerAiSql } from '../rules/population';
import { factRelation } from '../warehouse/read';
import { reportingLogRelation } from '../warehouse/reporting-relations';
import { warehouseTime } from '../warehouse/fact-input';
import { warehouseReportQuery, withinWarehouseReport } from './warehouse-report-snapshot';
import { query } from './server';
const count = (value: unknown) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('warehouse-presence-number-out-of-range');
  return n;
};

export async function warehouseCollectionPresence(site: string) {
  return withinWarehouseReport(async () => {
    const [website] = await query<{ created_at: Date }>(
      'SELECT created_at FROM website WHERE website_id=$1::uuid',
      site,
    );
    const [row] = await warehouseReportQuery<any>(
      site,
      `SELECT toFloat64(count()) AS pageviews,minOrNull(created_at) AS firstAt,maxOrNull(created_at) AS lastAt
       FROM ${factRelation('website_event', { columns: ['event_type', 'created_at'], immutableTimeWindow: { start: 'presenceStart', end: 'presenceEnd' } })} WHERE event_type=1
       AND created_at BETWEEN {presenceStart:DateTime64(6)} AND {presenceEnd:DateTime64(6)}`,
      {
        presenceStart: warehouseTime(website?.created_at ?? new Date(0)),
        presenceEnd: warehouseTime(new Date()),
      },
    );
    const iso = (value: string | null) =>
      value
        ? new Date(value.replace(' ', 'T') + (value.endsWith('Z') ? '' : 'Z')).toISOString()
        : null;
    return { pageviews: count(row.pageviews), firstAt: iso(row.firstAt), lastAt: iso(row.lastAt) };
  });
}

export async function warehouseInstallationLogs(site: string) {
  return withinWarehouseReport(async () => {
    const [counts] = await warehouseReportQuery<any>(
      site,
      `SELECT toFloat64(count()) AS total,toFloat64(countIf(${crawlerAiSql('l')})) AS ai,
       maxOrNull(created_at) AS latestAt FROM ${reportingLogRelation({}, ['created_at', 'ai_eligible', 'bot_type'])} l`,
    );
    const [metadata] = await query<any>(
      `SELECT (SELECT max(imported_at) FROM liekan_import WHERE website_id=$1::uuid) AS "latestImportAt",
       coalesce((SELECT is_demo FROM liekan_setting WHERE website_id=$1::uuid),false) AS demo`,
      site,
    );
    return {
      ...counts,
      total: count(counts.total),
      ai: count(counts.ai),
      ...metadata,
      latestAt: counts.latestAt ? new Date(counts.latestAt.replace(' ', 'T') + 'Z') : null,
    };
  });
}

export async function warehouseBrowserConnected(site: string) {
  const [row] = await warehouseReportQuery<{ connected: number }>(
    site,
    `SELECT EXISTS(SELECT 1 FROM ${factRelation('website_event')} LIMIT 1) AS connected`,
  );
  return { connected: !!row.connected };
}
