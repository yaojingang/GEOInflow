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
  // The notice covers every manageable site, not just the visible 50-row page.
  // Published source candidates skip never-collected sites; CH applies deletions.
  let cursor: string | null = null;
  while (!result.hasEligibleData) {
    const sites = await repairTransaction(async tx => {
      const [user] = await tx.$queryRawUnsafe<{ role: string }[]>(
        'SELECT role FROM "user" WHERE user_id=$1::uuid AND deleted_at IS NULL',
        identity.userId,
      );
      const { hasPermission } = await import('@/lib/auth'),
        { PERMISSIONS } = await import('@/lib/constants');
      if (!user) return [];
      const admin = await hasPermission(user.role, PERMISSIONS.all);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT w.website_id::text AS id FROM website w JOIN liekan_history_repair_campaign c ON c.id=$3
        LEFT JOIN liekan_setting s USING(website_id) JOIN liekan_warehouse_site wh ON wh.website_id=w.website_id
        WHERE w.deleted_at IS NULL AND w.website_id=ANY(c.eligible_websites) AND c.state='active' AND NOT coalesce(s.is_demo,false)
        AND ($2 OR w.user_id=$1::uuid OR EXISTS(SELECT 1 FROM team_user tu JOIN team t ON t.team_id=tu.team_id WHERE tu.user_id=$1::uuid AND tu.team_id=w.team_id AND t.deleted_at IS NULL AND tu.role IN('team-owner','team-manager','team-member')))
        AND ($4::uuid IS NULL OR w.website_id>$4::uuid)
        AND EXISTS(SELECT 1 FROM liekan_warehouse_candidate a WHERE a.website_id=w.website_id AND a.epoch=wh.epoch AND a.status='published' AND a.family IN('website_event','liekan_log') AND a.row_count>0)
        ORDER BY w.website_id LIMIT 50`,
        identity.userId,
        admin,
        HISTORY_REPAIR_CAMPAIGN,
        cursor,
      );
    });
    if (!sites.length) break;
    for (const site of sites) {
      await repairTransaction(tx => lockWritableWebsite(tx, site.id, identity, 'share'));
      if (await warehouseRepairHasData(site.id)) {
        await repairTransaction(tx => lockWritableWebsite(tx, site.id, identity, 'share'));
        result.hasEligibleData = true;
        break;
      }
    }
    cursor = sites.at(-1).id;
  }
  await repairTransaction(async tx => {
    for (const site of result.websites) await lockWritableWebsite(tx, site.id, identity, 'share');
  });
  return result;
}
