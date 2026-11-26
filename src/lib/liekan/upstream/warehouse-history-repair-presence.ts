import type { HistoryRepairDetail, HistoryRepairList } from '../contracts/history-repair';
import { HISTORY_REPAIR_CAMPAIGN } from '../contracts/history-repair';
import { factRelation } from '../warehouse/read';
import { repairTransaction } from './history-repair-db';
import { lockWritableWebsite, type WriteIdentity } from './server';
import { warehouseReportQuery } from './warehouse-report-snapshot';

// Presence is raw surviving input, independently of browser eligibility and of
// whether any repair output exists. Keep CH work outside PG permission locks.
export async function warehouseRepairHasData(site: string) {
  const [r] = await warehouseReportQuery<{ present: number }>(
    site,
    `SELECT
    EXISTS(SELECT 1 FROM ${factRelation('website_event')} LIMIT 1) OR
    EXISTS(SELECT 1 FROM ${factRelation('liekan_log')} LIMIT 1) AS present`,
  );
  return !!r.present;
}
export async function repairDetailPresence(
  site: string,
  identity: WriteIdentity,
  detail: HistoryRepairDetail,
) {
  detail.hasData = await warehouseRepairHasData(site);
  await repairTransaction(tx => lockWritableWebsite(tx, site, identity, 'share'));
  return detail;
}
export async function repairListPresence<T extends HistoryRepairList>(identity: WriteIdentity, result: T) {
  const values = await Promise.all(
    result.websites.map(async site => ({
      id: site.id,
      present: await warehouseRepairHasData(site.id),
    })),
  );
  for (const site of result.websites) site.hasData = values.find(v => v.id === site.id).present;
  result.hasEligibleData = result.websites.some(w => w.eligible && w.hasData);
  await repairTransaction(async tx => {
    for (const site of result.websites) await lockWritableWebsite(tx, site.id, identity, 'share');
  });
  return result;
}
