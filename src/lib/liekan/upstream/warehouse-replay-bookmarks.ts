import { randomUUID } from 'node:crypto';
import type { ControlSQL } from '../warehouse/control-db';
import { factRelation } from '../warehouse/read';
import { warehouseReader } from '../warehouse/reader-runtime';
import { LiekanError, lockWritableWebsite, type WriteIdentity } from './server';
import { warehouseControlAdapter } from './warehouse-authority';
import {
  warehouseReportMetadata,
  warehouseReportQuery,
  withinWarehouseReport,
} from './warehouse-report-snapshot';

export async function createWarehouseReplayBookmark(
  site: string,
  visit: string,
  name: string,
  identity: WriteIdentity,
) {
  if (!identity?.userId) throw new LiekanError('请登录后再操作', 401);
  const db = warehouseReader().db;
  await db.transaction(tx =>
    lockWritableWebsite(warehouseControlAdapter(tx), site, identity, 'share'),
  );
  const { initial, owners } = await withinWarehouseReport(async () => {
    const initial = await warehouseReportMetadata(site);
    const owners = await warehouseReportQuery<{ session_id: string }>(
      site,
      `SELECT DISTINCT session_id FROM ${factRelation('session_replay')}
      WHERE visit_id={visit:UUID} ORDER BY session_id LIMIT 2`,
      { visit },
    );
    if (owners.length !== 1)
      throw new LiekanError('录屏已删除或所属访问不明确', 409, 'warehouse-replay-unavailable');
    return { initial, owners };
  });
  // Confirm the read before mutating bookmark_revision. A read-only report
  // fence after this transaction would reject our own successful write.
  return db.transaction(async tx => {
    await lockWritableWebsite(warehouseControlAdapter(tx), site, identity, 'share');
    const [current] = (
      await tx.query<{ epoch: string; deletion_revision: string; state: string }>(
        'SELECT * FROM liekan_warehouse_site WHERE website_id=$1 FOR SHARE',
        [site],
      )
    ).rows;
    if (
      current?.state !== 'active' ||
      current.epoch !== initial.boundary.epoch ||
      current.deletion_revision !== initial.boundary.deletionRevision ||
      (
        await tx.query(
          "SELECT 1 FROM liekan_warehouse_deletion WHERE website_id=$1 AND status NOT IN('active','reclaimed') AND (session_id IS NULL OR session_id=$2) LIMIT 1",
          [site, owners[0].session_id],
        )
      ).rowCount
    )
      throw new LiekanError('录屏所属访问正在变化，请重试', 409, 'warehouse-replay-source-changed');
    const [saved] = (
      await tx.query<{
        id: string;
        name: string;
        websiteId: string;
        visitId: string;
        createdAt: Date;
        updatedAt: Date;
      }>(
        `INSERT INTO session_replay_saved(saved_replay_id,website_id,visit_id,name,created_at,updated_at) VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp())
        RETURNING saved_replay_id AS id,website_id AS "websiteId",visit_id AS "visitId",name,created_at AS "createdAt",updated_at AS "updatedAt"`,
        [randomUUID(), site, visit, name],
      )
    ).rows;
    await tx.query(
      'INSERT INTO liekan_warehouse_replay_bookmark_owner(saved_replay_id,website_id,session_id) VALUES($1,$2,$3)',
      [saved.id, site, owners[0].session_id],
    );
    return saved;
  });
}

// Invoke against the PG business clone while legacy facts are still present and
// frozen. A resumable migration batch reads at most 1000 bookmark IDs.
export async function initializeWarehouseReplayBookmarks(
  tx: ControlSQL,
  site: string,
  after: string | null = null,
) {
  const rows = (
    await tx.query<{ id: string }>(
      `SELECT saved_replay_id AS id FROM session_replay_saved
    WHERE website_id=$1 AND ($2::uuid IS NULL OR saved_replay_id>$2) ORDER BY saved_replay_id LIMIT 1000`,
      [site, after],
    )
  ).rows;
  if (!rows.length) return null;
  await tx.query(
    `INSERT INTO liekan_warehouse_replay_bookmark_owner(saved_replay_id,website_id,session_id)
    SELECT s.saved_replay_id,s.website_id,parents.session_id FROM session_replay_saved s
    CROSS JOIN LATERAL (SELECT session_id FROM session_replay r WHERE r.website_id=s.website_id AND r.visit_id=s.visit_id
      UNION SELECT session_id FROM website_event e WHERE e.website_id=s.website_id AND e.visit_id=s.visit_id) parents
    WHERE s.website_id=$1 AND s.saved_replay_id=ANY($2::uuid[]) ON CONFLICT DO NOTHING`,
    [site, rows.map(r => r.id)],
  );
  return rows.at(-1).id;
}
