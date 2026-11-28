import { randomUUID } from 'node:crypto';
import { hasPermission } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/constants';
import type { PoolClient } from 'pg';
import type { ControlSQL } from '../warehouse/control-db';
import { readV2SessionHours } from '../warehouse-v2/lifecycle';
import {
  clearV2CatalogCache,
  clearV2SiteMetaCache,
  deleteV2Session,
  purgeV2SiteEpoch,
  warehouseV2Runtime,
} from '../warehouse-v2/index';
import { bumpAnalyticsRevision } from './analytics-revision';
import { clearAiWebsiteInTransaction } from './ai-lifecycle';
import { resetLiekanStatistics, stopWebsiteSources } from './lifecycle';
import { invalidateWebsiteAnalytics } from './query-cache';
import { LiekanError, lockWritableWebsite, type WriteIdentity } from './server';
import { warehouseControlAdapter } from './warehouse-authority';

export type DeletionKind = 'reset' | 'website' | 'session';

export async function assertWarehouseLifecycleEditable(_tx: any, _site: string) {
  // Warehouse v2 uses instant epoch fencing and needs no pending task barrier.
}

async function authorize(
  tx: ControlSQL,
  site: string,
  kind: DeletionKind,
  identity: WriteIdentity,
) {
  if (!identity?.userId) throw new LiekanError('请先登录', 401);
  await lockWritableWebsite(warehouseControlAdapter(tx), site, identity);
  if (kind === 'reset') return;
  const [user] = (
    await tx.query<{ role: string }>(
      'SELECT role FROM "user" WHERE user_id=$1 AND deleted_at IS NULL FOR SHARE',
      [identity.userId],
    )
  ).rows;
  if (await hasPermission(user.role, PERMISSIONS.all)) return;
  const [owner] = (
    await tx.query<{ user_id: string | null; team_id: string | null }>(
      'SELECT user_id,team_id FROM website WHERE website_id=$1',
      [site],
    )
  ).rows;
  if (owner.user_id === identity.userId) return;
  const [member] = (
    await tx.query<{ role: string }>(
      'SELECT role FROM team_user WHERE team_id=$1 AND user_id=$2 FOR SHARE',
      [owner.team_id, identity.userId],
    )
  ).rows;
  if (!member || !(await hasPermission(member.role, PERMISSIONS.websiteDelete)))
    throw new LiekanError('无权执行该删除操作', 403);
}

async function applyDeletionControl(
  client: PoolClient,
  site: string,
  kind: DeletionKind,
  session: string | null,
  identity: WriteIdentity,
  oldEpoch: string,
) {
  const sql = warehouseControlAdapter(client);
  let targetEpoch = oldEpoch;
  if (kind === 'session') {
    if (!session) throw new LiekanError('缺少会话 ID', 400);
    await client.query(
      'DELETE FROM session_replay_saved WHERE website_id=$1::uuid AND visit_id IN (SELECT DISTINCT visit_id FROM website_event WHERE website_id=$1::uuid AND session_id=$2::uuid)',
      [site, session],
    );
  } else if (kind === 'reset') {
    await resetLiekanStatistics(sql, site, identity);
    await client.query('UPDATE website SET reset_at=clock_timestamp() WHERE website_id=$1::uuid', [
      site,
    ]);
    const nextRow = (
      await client.query<{ epoch: string }>(
        'SELECT epoch::text FROM liekan_log_state WHERE website_id=$1::uuid',
        [site],
      )
    ).rows[0];
    targetEpoch = nextRow?.epoch ?? String(BigInt(oldEpoch) + 1n);
  } else {
    await stopWebsiteSources(sql, site, true);
    await clearAiWebsiteInTransaction(sql, site);
    for (const table of ['report', 'segment', 'annotation']) {
      await client.query(`DELETE FROM ${table} WHERE website_id=$1::uuid`, [site]);
    }
    await client.query('DELETE FROM share WHERE entity_id=$1::uuid', [site]);
    if (process.env.CLOUD_MODE) {
      await client.query(
        'UPDATE website SET deleted_at=clock_timestamp() WHERE website_id=$1::uuid',
        [site],
      );
    } else {
      await client.query('DELETE FROM website WHERE website_id=$1::uuid', [site]);
    }
    targetEpoch = String(BigInt(oldEpoch) + 1n);
  }
  await bumpAnalyticsRevision(sql, 'website', site);
  return targetEpoch;
}

type DeletionFence = {
  revision: string;
  pending_kind: 'reset' | 'session' | null;
  session_id: string | null;
  epoch: string;
  touched_hours: string[] | null;
};

export async function deleteWarehouseStatistics(
  site: string,
  kind: DeletionKind,
  identity: WriteIdentity,
  session: string | null = null,
) {
  const rt = warehouseV2Runtime();
  await rt.ensureReady();
  const client = await rt.pg.connect();
  let targetEpoch: string;
  let revision = '0';

  try {
    await client.query('BEGIN');
    await authorize(client, site, kind, identity);
    // The website lock serializes control changes. A committed pending row remains
    // visible to readers while another transaction performs the ClickHouse cleanup.
    const previous =
      kind === 'website'
        ? null
        : (
            await client.query<DeletionFence>(
              'SELECT revision::text,pending_kind,session_id,epoch::text,touched_hours FROM liekan_v2_evidence_deletion WHERE website_id=$1 FOR UPDATE NOWAIT',
              [site],
            )
          ).rows[0];

    if (previous?.pending_kind) {
      if (previous.pending_kind !== kind || previous.session_id !== session)
        throw new LiekanError('此网站有另一项统计清理尚未完成', 409);
      revision = previous.revision;
      targetEpoch = previous.epoch;
    } else {
      const state = (
        await client.query<{ epoch: string }>(
          'SELECT epoch::text FROM liekan_log_state WHERE website_id=$1',
          [site],
        )
      ).rows[0];
      const oldEpoch = state?.epoch ?? '1';
      targetEpoch = await applyDeletionControl(client, site, kind, session, identity, oldEpoch);
      if (kind !== 'website') {
        const hours =
          kind === 'session' ? await readV2SessionHours(rt.ch, site, oldEpoch, session!) : null;
        const saved = await client.query<{ revision: string }>(
          `INSERT INTO liekan_v2_evidence_deletion (website_id,revision,pending_kind,session_id,epoch,touched_hours)
           VALUES ($1,1,$2,$3,$4,$5)
           ON CONFLICT (website_id) DO UPDATE SET revision=liekan_v2_evidence_deletion.revision+1,
             pending_kind=excluded.pending_kind,session_id=excluded.session_id,epoch=excluded.epoch,touched_hours=excluded.touched_hours
           RETURNING revision::text`,
          [site, kind, session, targetEpoch, hours],
        );
        revision = saved.rows[0].revision;
      }
    }
    await client.query('COMMIT');
    clearV2CatalogCache(site);
    clearV2SiteMetaCache(site);
    invalidateWebsiteAnalytics(site);

    if (kind === 'website') {
      await purgeV2SiteEpoch(rt.ch, site, targetEpoch);
    } else {
      await client.query('BEGIN');
      const pending = (
        await client.query<DeletionFence>(
          `SELECT revision::text,pending_kind,session_id,epoch::text,touched_hours
         FROM liekan_v2_evidence_deletion WHERE website_id=$1 AND revision=$2 AND pending_kind IS NOT NULL FOR UPDATE`,
          [site, revision],
        )
      ).rows[0];
      if (pending) {
        if (pending.pending_kind === 'session')
          await deleteV2Session(
            rt.ch,
            site,
            pending.epoch,
            pending.session_id!,
            pending.touched_hours!,
          );
        else await purgeV2SiteEpoch(rt.ch, site, pending.epoch);
        await client.query(
          'UPDATE liekan_v2_evidence_deletion SET pending_kind=NULL,session_id=NULL,touched_hours=NULL WHERE website_id=$1 AND revision=$2',
          [site, revision],
        );
      }
      await client.query('COMMIT');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if ((error as { code?: string }).code === '55P03') {
      throw new LiekanError('此网站正在清理统计，请稍后重试', 409);
    }
    throw error;
  } finally {
    client.release();
  }

  return {
    operation_id: randomUUID(),
    website_id: site,
    kind,
    session_id: session,
    status: 'active',
    epoch: targetEpoch,
    deletion_revision: revision,
    site_version: '0',
    target_publication: null,
    owner_id: null,
    lease_until: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}
