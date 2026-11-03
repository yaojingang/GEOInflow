import { randomUUID } from 'node:crypto';
import { trafficExclusionActionSchema } from '../contracts/traffic-exclusions';
import {
  assessBrowserBehavior,
  BROWSER_RISK_VERSION,
  BROWSER_RISK_WINDOW_LIMIT,
} from '../traffic-quality/behavior';
import type { SiteState } from '../warehouse/control';
import type { ControlSQL } from '../warehouse/control-db';
import { factInput, warehouseTime } from '../warehouse/fact-input';
import { factRelation } from '../warehouse/read';
import { riskRelation } from '../warehouse/risk-proof';
import { type WarehouseRuntime, warehouseRuntime } from '../warehouse/runtime';
import { prepareWarehouseTask, waitWarehouseTask } from '../warehouse/tasks';
import { bumpAnalyticsRevision } from './analytics-revision';
import { invalidateWebsiteAnalytics } from './query-cache';
import { LiekanError, lockWritableWebsite, type WriteIdentity } from './server';
import { exclusionDigest, trafficGovernanceBoundary } from './traffic-exclusions';
import { warehouseControlAdapter } from './warehouse-authority';
import { warehouseRiskWindowEvents } from './warehouse-browser-risk';
import { assertTransitionMaintenance } from './warehouse-maintenance';
import {
  warehouseReportMetadata,
  warehouseReportQuery,
  withinWarehouseReport,
} from './warehouse-report-snapshot';

const conflict = () => new LiekanError('治理依据已变化或预览已过期，请重新预览', 409);
async function windowControl(tx: ControlSQL, site: string, end: Date, epoch: string) {
  const [w] = (
    await tx.query<{ epoch: string; rule_version: string; coverage: string; computed_at: string }>(
      `SELECT epoch::text,rule_version,coverage,to_char(computed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS computed_at
      FROM liekan_browser_risk_window WHERE website_id=$1 AND window_end=$2`,
      [site, end],
    )
  ).rows;
  if (
    !w ||
    w.epoch !== epoch ||
    w.coverage !== 'observed' ||
    w.rule_version !== BROWSER_RISK_VERSION
  )
    throw conflict();
  return w;
}
async function storedPreview(tx: ControlSQL, site: string, id: string, lock = false) {
  return (
    await tx.query<any>(
      `SELECT *,epoch::text,base_revision::text,policy_revision::text,catalog_version::text,
    history_generation::text,history_revision::text,(expires_at>clock_timestamp()) AS fresh
    FROM liekan_traffic_exclusion WHERE website_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`,
      [site, id],
    )
  ).rows[0];
}
function checkStored(stored: any, current: any, digest: string) {
  if (
    !stored ||
    stored.epoch !== current.epoch ||
    stored.state !== 'preview' ||
    !stored.fresh ||
    stored.membership_digest !== digest ||
    stored.base_revision !== current.revision ||
    [
      'policy_revision',
      'rule_version',
      'catalog_version',
      'history_generation',
      'history_revision',
    ].some(k => stored[k] !== current[k])
  )
    throw conflict();
}
async function revision(
  tx: ControlSQL,
  site: string,
  id: string,
  actor: string,
  operation: 'confirm' | 'revoke',
) {
  const [next] = (
    await tx.query<{ revision: string }>(
      `UPDATE liekan_traffic_governance SET revision=revision+1,updated_at=clock_timestamp()
    WHERE website_id=$1 RETURNING revision::text`,
      [site],
    )
  ).rows;
  await tx.query(
    `INSERT INTO liekan_traffic_governance_revision(website_id,revision,actor_id,collection_id,operation) VALUES($1,$2,$3,$4,$5)`,
    [site, next.revision, actor, id, operation],
  );
  await tx.query('UPDATE liekan_warehouse_site SET governance_revision=$2 WHERE website_id=$1', [
    site,
    next.revision,
  ]);
  await bumpAnalyticsRevision(warehouseControlAdapter(tx), 'website', site);
  return { action: operation, id, revision: next.revision };
}

export async function actOnWarehouseTrafficExclusion(
  site: string,
  input: unknown,
  identity: WriteIdentity,
  suppliedRuntime?: WarehouseRuntime,
) {
  const parsed = trafficExclusionActionSchema.safeParse(input);
  if (!parsed.success) throw new LiekanError('流量治理参数无效');
  const action = parsed.data,
    runtime = suppliedRuntime ?? (await warehouseRuntime());
  // No CH query runs while holding a PG permission/control transaction.
  if (action.action === 'revoke') {
    const result = await runtime.db.transaction(async tx => {
      await assertTransitionMaintenance(warehouseControlAdapter(tx), 'governance');
      const [state] = (
        await tx.query<SiteState>(
          'SELECT * FROM liekan_warehouse_site WHERE website_id=$1 FOR UPDATE',
          [site],
        )
      ).rows;
      if (state?.state !== 'active') throw conflict();
      const sql = warehouseControlAdapter(tx);
      await lockWritableWebsite(sql, site, identity);
      const current = await trafficGovernanceBoundary(sql, site);
      if (current.revision !== action.expectedRevision) throw conflict();
      const stored = await storedPreview(tx, site, action.collectionId, true);
      if (!stored || stored.state !== 'active' || stored.epoch !== current.epoch) throw conflict();
      await tx.query(
        "UPDATE liekan_traffic_exclusion SET state='revoked',revoked_at=clock_timestamp() WHERE id=$1",
        [action.collectionId],
      );
      return revision(tx, site, action.collectionId, identity.userId, 'revoke');
    });
    invalidateWebsiteAnalytics(site);
    return result;
  }
  const basis = await withinWarehouseReport(async () => {
    const metadata = await warehouseReportMetadata(site);
    const initial = await runtime.db.transaction(async tx => {
      await assertTransitionMaintenance(warehouseControlAdapter(tx), 'governance');
      const sql = warehouseControlAdapter(tx);
      await lockWritableWebsite(sql, site, identity, 'share');
      const current = await trafficGovernanceBoundary(sql, site);
      if (current.revision !== action.expectedRevision) throw conflict();
      const stored =
        action.action === 'confirm' ? await storedPreview(tx, site, action.previewId) : null;
      if (action.action === 'confirm') checkStored(stored, current, action.digest);
      const end =
        action.action === 'preview' ? new Date(action.windowEnd) : new Date(stored.window_end);
      const window = await windowControl(tx, site, end, current.epoch);
      if (stored && window.computed_at !== stored.evidence.windowComputedAt) throw conflict();
      return { current, stored, end, window };
    });
    const rows = await warehouseRiskWindowEvents(site, initial.end);
    if (rows.length > BROWSER_RISK_WINDOW_LIMIT)
      throw new LiekanError('观察窗口超过事件预算，无法确认完整范围', 413);
    const visits = action.action === 'preview' ? action.visits : initial.stored.evidence.visits;
    const keys = new Set<string>(visits.map((v: any) => `${v.sessionId}:${v.visitId}`));
    if (keys.size !== visits.length) throw new LiekanError('候选访问重复');
    const eligible = rows.filter(r => r.admissible);
    if (action.action === 'preview') {
      const candidates = await warehouseReportQuery<{ session_id: string; visit_id: string }>(
        site,
        `SELECT session_id,visit_id FROM ${riskRelation({ immutableTimeWindow: { start: 'riskWindow', end: 'riskWindow' } })} WHERE window_end={riskWindow:DateTime64(6,'UTC')}`,
        {
          riskWindow: warehouseTime(initial.end),
          riskRule: BROWSER_RISK_VERSION,
          riskEpoch: initial.current.epoch,
        },
      );
      const found = new Set(candidates.map(r => `${r.session_id}:${r.visit_id}`));
      for (const key of keys) {
        if (!found.has(key)) throw conflict();
        const assessment = assessBrowserBehavior(
          eligible
            .filter(r => r.event_type === 1 && `${r.session_id}:${r.visit_id}` === key)
            .map(r => ({ observedAt: +r.received_at, path: r.url_path })),
          true,
        );
        if (assessment.state !== 'review') throw conflict();
      }
    }
    const selected = eligible.filter(r => keys.has(`${r.session_id}:${r.visit_id}`));
    if (!selected.length || selected.some(r => !r.identity_available)) throw conflict();
    const ids = selected.map(r => r.event_id),
      digest = exclusionDigest(ids);
    if (action.action === 'confirm') {
      if (digest !== action.digest) throw conflict();
      const members = await warehouseReportQuery<{ event_id: string }>(
        site,
        `SELECT event_id FROM ${factRelation('liekan_traffic_exclusion_member')} WHERE collection_id={collection:UUID}`,
        { collection: action.previewId },
      );
      if (exclusionDigest(members.map(m => m.event_id)) !== action.digest) throw conflict();
    }
    return { ...initial, metadata, visits, selected, ids, digest };
  });
  const validate = async (tx: ControlSQL) => {
    const sql = warehouseControlAdapter(tx);
    await assertTransitionMaintenance(sql, 'governance');
    await lockWritableWebsite(sql, site, identity);
    const current = await trafficGovernanceBoundary(sql, site);
    if (JSON.stringify(current) !== JSON.stringify(basis.current)) throw conflict();
    const [state] = (
      await tx.query<SiteState>(
        'SELECT * FROM liekan_warehouse_site WHERE website_id=$1 FOR UPDATE',
        [site],
      )
    ).rows;
    if (
      !state ||
      state.state !== 'active' ||
      state.epoch !== basis.metadata.boundary.epoch ||
      state.publication !== basis.metadata.boundary.publication ||
      state.deletion_revision !== basis.metadata.boundary.deletionRevision
    )
      throw conflict();
    if (
      (await windowControl(tx, site, basis.end, current.epoch)).computed_at !==
      basis.window.computed_at
    )
      throw conflict();
    if (
      (
        await tx.query(
          "SELECT 1 FROM liekan_warehouse_deletion WHERE website_id=$1 AND status NOT IN('active','reclaimed') LIMIT 1",
          [site],
        )
      ).rowCount
    )
      throw conflict();
    return current;
  };
  if (action.action === 'preview') {
    const id = randomUUID(),
      state = await runtime.resource(site, 'website');
    const evidence = {
      visits: basis.visits,
      events: basis.ids.length,
      pageviews: basis.selected.filter(r => r.event_type === 1).length,
      coverage: 'observed',
      behaviorVersion: BROWSER_RISK_VERSION,
      windowComputedAt: basis.window.computed_at,
    };
    let expiresAt: Date;
    const taskId = await prepareWarehouseTask(
      runtime,
      state,
      {
        kind: 'traffic-exclusion',
        collectionId: id,
        actorId: identity.userId,
        windowEnd: basis.end.toISOString(),
        digest: basis.digest,
        events: basis.ids.length,
      },
      basis.selected.map(({ event_id, session_id }) => ({
        family: 'liekan_traffic_exclusion_member',
        sessionId: session_id,
        row: factInput('liekan_traffic_exclusion_member', {
          website_id: site,
          collection_id: id,
          event_id,
        }),
      })),
      async tx => {
        const current = await validate(tx);
        await tx.query(
          'INSERT INTO liekan_traffic_governance(website_id) VALUES($1) ON CONFLICT DO NOTHING',
          [site],
        );
        const [preview] = (
          await tx.query<{ expires_at: Date }>(
            `INSERT INTO liekan_traffic_exclusion(id,website_id,epoch,actor_id,state,base_revision,
          policy_revision,rule_version,catalog_version,history_generation,history_revision,window_end,received_cutoff,membership_digest,evidence,expires_at)
          VALUES($1,$2,$3,$4,'preview',$5,$6,$7,$8,$9,$10,$11,$11,$12,$13::jsonb,clock_timestamp()+interval '15 minutes') RETURNING expires_at`,
            [
              id,
              site,
              current.epoch,
              identity.userId,
              current.revision,
              current.policy_revision,
              current.rule_version,
              current.catalog_version,
              current.history_generation,
              current.history_revision,
              basis.end,
              basis.digest,
              JSON.stringify(evidence),
            ],
          )
        ).rows;
        expiresAt = preview.expires_at;
      },
    );
    await waitWarehouseTask(runtime.db, taskId);
    // Recheck current permission after the queue acknowledgement as well.
    await runtime.db.transaction(tx =>
      lockWritableWebsite(warehouseControlAdapter(tx), site, identity, 'share'),
    );
    return {
      action: 'preview',
      id,
      digest: basis.digest,
      expiresAt,
      revision: basis.current.revision,
      evidence,
    };
  }
  const result = await runtime.db.transaction(async tx => {
    await tx.query('SELECT website_id FROM liekan_warehouse_site WHERE website_id=$1 FOR UPDATE', [
      site,
    ]);
    const current = await validate(tx),
      stored = await storedPreview(tx, site, action.previewId, true);
    checkStored(stored, current, action.digest);
    await tx.query(
      "UPDATE liekan_traffic_exclusion SET state='active',confirmed_at=clock_timestamp() WHERE id=$1",
      [action.previewId],
    );
    return revision(tx, site, action.previewId, identity.userId, 'confirm');
  });
  invalidateWebsiteAnalytics(site);
  return result;
}
