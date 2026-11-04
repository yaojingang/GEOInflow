import { warehouseEnabled } from '@/lib/liekan/warehouse/authority-routing';
import { assertTransitionMaintenance } from './warehouse-maintenance';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { trafficExclusionActionSchema } from '../contracts/traffic-exclusions';
import {
  assessBrowserBehavior,
  BROWSER_RISK_VERSION,
  BROWSER_RISK_WINDOW_LIMIT,
} from '../traffic-quality/behavior';
import { bumpAnalyticsRevision } from './analytics-revision';
import { COLLECTION_RULE_VERSION } from './collection-quality';
import { invalidateWebsiteAnalytics } from './query-cache';
import { LiekanError, lockWritableWebsite, transaction, type WriteIdentity } from './server';

const campaign = 'traffic-quality-repair-20261022-v1';
const conflict = () => new LiekanError('治理依据已变化或预览已过期，请重新预览', 409);
export const exclusionDigest = (ids: string[]) =>
  createHash('sha256')
    .update(JSON.stringify([...new Set(ids)].sort()))
    .digest('hex');

export async function trafficGovernanceBoundary(tx: any, websiteId: string) {
  const [state] = await tx.$queryRawUnsafe(
    `SELECT coalesce(g.revision,0)::text AS revision,
    coalesce(l.epoch,1)::text AS epoch,coalesce(p.revision,0)::text AS policy_revision,
    r.active_generation::text AS history_generation,coalesce(r.active_revision,0)::text AS history_revision
    FROM website w LEFT JOIN liekan_traffic_governance g ON g.website_id=w.website_id
    LEFT JOIN liekan_log_state l ON l.website_id=w.website_id
    LEFT JOIN liekan_collection_policy p ON p.website_id=w.website_id
    LEFT JOIN liekan_history_repair_run r ON r.website_id=w.website_id AND r.campaign_id=$2
    WHERE w.website_id=$1::uuid`,
    websiteId,
    campaign,
  );
  const [catalog] = await tx.$queryRawUnsafe(
    'SELECT version::text FROM liekan_crawler_registry_current WHERE id=1 FOR SHARE',
  );
  return {
    ...state,
    catalog_version: catalog?.version ?? null,
    rule_version: COLLECTION_RULE_VERSION,
  };
}

async function windowEvidence(tx: any, websiteId: string, windowEnd: Date, epoch: string) {
  const [window] = await tx.$queryRawUnsafe(
    `SELECT epoch::text,rule_version,coverage,computed_at
    FROM liekan_browser_risk_window WHERE website_id=$1::uuid AND window_end=$2`,
    websiteId,
    windowEnd,
  );
  if (
    !window ||
    window.epoch !== epoch ||
    window.coverage !== 'observed' ||
    window.rule_version !== BROWSER_RISK_VERSION
  )
    throw conflict();
  const rows = await tx.$queryRawUnsafe(
    `SELECT e.event_id::text,e.session_id::text,e.visit_id::text,e.event_type,e.url_path,
    q.created_at AS received_at,q.source,c.classification,coalesce(env.identity_available,false) AS identity_available,
    EXISTS(SELECT 1 FROM liekan_admissible_browser_event a WHERE a.website_id=e.website_id AND a.event_id=e.event_id) AS admissible
    FROM liekan_event_quality q JOIN website_event e ON e.event_id=q.event_id AND e.website_id=q.website_id
    JOIN liekan_reporting_event_quality c ON c.event_id=q.event_id AND c.website_id=q.website_id
    LEFT JOIN liekan_browser_identity env ON env.event_id=e.event_id AND env.website_id=e.website_id
    WHERE q.website_id=$1::uuid AND q.created_at>$2::timestamptz-interval '5 minutes' AND q.created_at<=$2
    ORDER BY q.created_at,q.event_id LIMIT $3`,
    websiteId,
    windowEnd,
    BROWSER_RISK_WINDOW_LIMIT + 1,
  );
  if (rows.length > BROWSER_RISK_WINDOW_LIMIT)
    throw new LiekanError('观察窗口超过事件预算，无法确认完整范围', 413);
  return { window, rows };
}

const governanceCursorSchema = z.object({
  websiteId: z.uuid(),
  revision: z.string().regex(/^\d+$/),
  epoch: z.string().regex(/^\d+$/),
  time: z.iso.datetime(),
  id: z.uuid(),
});
export async function trafficGovernanceState(tx: any, websiteId: string, cursor?: string) {
  let position: z.infer<typeof governanceCursorSchema> | undefined;
  if (cursor) {
    try {
      if (cursor.length > 1024) throw new Error();
      position = governanceCursorSchema.parse(
        JSON.parse(Buffer.from(cursor, 'base64url').toString()),
      );
    } catch {
      throw new LiekanError('治理分页参数无效');
    }
  }
  const [state] = await tx.$queryRawUnsafe(
    `SELECT coalesce(g.revision,0)::text AS revision,
    coalesce(l.epoch,1)::text AS epoch,s.next_window AS "nextWindow",s.computed_at AS "computedAt",s.error_code AS "errorCode"
    FROM website w LEFT JOIN liekan_traffic_governance g ON g.website_id=w.website_id
    LEFT JOIN liekan_log_state l ON l.website_id=w.website_id
    LEFT JOIN liekan_browser_risk_state s ON s.website_id=w.website_id WHERE w.website_id=$1::uuid`,
    websiteId,
  );
  if (
    position &&
    (position.websiteId !== websiteId ||
      position.revision !== state.revision ||
      position.epoch !== state.epoch)
  )
    throw conflict();
  const warehouse = warehouseEnabled();
  const collections = await tx.$queryRawUnsafe(
    `SELECT x.id::text,x.state,x.epoch::text,x.window_end AS "windowEnd",
    x.created_at AS "createdAt",to_char(x.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime",x.confirmed_at AS "confirmedAt",x.revoked_at AS "revokedAt",
    x.membership_digest AS digest,x.evidence, ${warehouse ? '0' : 'count(m.event_id)::int'} AS events
    FROM liekan_traffic_exclusion x ${warehouse ? '' : 'LEFT JOIN liekan_traffic_exclusion_member m ON m.collection_id=x.id AND m.website_id=x.website_id'}
    WHERE x.website_id=$1::uuid AND x.state IN('active','revoked')
      AND ($2::timestamptz IS NULL OR (x.created_at,x.id)<($2::timestamptz,$3::uuid))
    GROUP BY x.id ORDER BY x.created_at DESC,x.id DESC LIMIT 101`,
    websiteId,
    position?.time ?? null,
    position?.id ?? null,
  );
  const last = collections[99];
  const nextCursor =
    collections.length > 100
      ? Buffer.from(
          JSON.stringify({
            websiteId,
            revision: state.revision,
            epoch: state.epoch,
            time: last.cursorTime,
            id: last.id,
          }),
        ).toString('base64url')
      : null;
  return {
    ...state,
    collections: collections.slice(0, 100).map(({ cursorTime, ...row }: any) => row),
    nextCursor,
  };
}

export async function actOnTrafficExclusion(
  websiteId: string,
  input: unknown,
  identity: WriteIdentity,
) {
  if (warehouseEnabled())
    return (await import('./warehouse-traffic-exclusions')).actOnWarehouseTrafficExclusion(
      websiteId,
      input,
      identity,
    );
  if (process.env.CLICKHOUSE_URL) throw new LiekanError('流量治理当前支持 PostgreSQL', 501);
  const parsed = trafficExclusionActionSchema.safeParse(input);
  if (!parsed.success) throw new LiekanError('流量治理参数无效');
  const action = parsed.data;
  const result = await transaction(async tx => {
    await lockWritableWebsite(tx, websiteId, identity);
    await assertTransitionMaintenance(tx, 'governance');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='15s'");
    await tx.$executeRawUnsafe(
      'INSERT INTO liekan_traffic_governance(website_id) VALUES($1::uuid) ON CONFLICT DO NOTHING',
      websiteId,
    );
    const current = await trafficGovernanceBoundary(tx, websiteId);
    if (current.revision !== action.expectedRevision) throw conflict();
    if (action.action === 'preview') {
      const windowEnd = new Date(action.windowEnd);
      const { window, rows } = await windowEvidence(tx, websiteId, windowEnd, current.epoch);
      const eligible = rows.filter((r: any) => r.admissible);
      const keys = new Set(action.visits.map(v => v.sessionId + ':' + v.visitId));
      if (keys.size !== action.visits.length) throw new LiekanError('候选访问重复');
      const candidates = await tx.$queryRawUnsafe(
        `SELECT session_id::text,visit_id::text FROM liekan_browser_risk
        WHERE website_id=$1::uuid AND window_end=$2`,
        websiteId,
        windowEnd,
      );
      for (const key of keys) {
        if (!candidates.some((r: any) => r.session_id + ':' + r.visit_id === key)) throw conflict();
        const assessment = assessBrowserBehavior(
          eligible
            .filter((r: any) => r.event_type === 1 && r.session_id + ':' + r.visit_id === key)
            .map((r: any) => ({ observedAt: +r.received_at, path: r.url_path })),
          true,
        );
        if (assessment.state !== 'review') throw conflict();
      }
      const selected = eligible.filter((r: any) => keys.has(r.session_id + ':' + r.visit_id));
      if (!selected.length) throw conflict();
      if (selected.some((r: any) => !r.identity_available))
        throw new LiekanError('候选访问缺少可靠身份依据，仅保留行为观察，暂不能确认排除', 409);
      const ids = selected.map((r: any) => r.event_id);
      const id = randomUUID(),
        digest = exclusionDigest(ids);
      const evidence = {
        visits: action.visits,
        events: ids.length,
        pageviews: selected.filter((r: any) => r.event_type === 1).length,
        coverage: 'observed',
        behaviorVersion: BROWSER_RISK_VERSION,
        windowComputedAt: window.computed_at.toISOString(),
      };
      const [preview] = await tx.$queryRawUnsafe(
        `INSERT INTO liekan_traffic_exclusion(id,website_id,epoch,actor_id,state,base_revision,
        policy_revision,rule_version,catalog_version,history_generation,history_revision,window_end,received_cutoff,membership_digest,evidence,expires_at)
        VALUES($1::uuid,$2::uuid,$3,$4::uuid,'preview',$5,$6,$7,$8::uuid,$9::uuid,$10,$11,$11,$12,$13::jsonb,clock_timestamp()+interval '15 minutes')
        RETURNING expires_at AS "expiresAt"`,
        id,
        websiteId,
        current.epoch,
        identity.userId,
        current.revision,
        current.policy_revision,
        current.rule_version,
        current.catalog_version,
        current.history_generation,
        current.history_revision,
        windowEnd,
        digest,
        JSON.stringify(evidence),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO liekan_traffic_exclusion_member(website_id,collection_id,event_id)
        SELECT $1::uuid,$2::uuid,unnest($3::uuid[])`,
        websiteId,
        id,
        ids,
      );
      return {
        action: 'preview',
        id,
        digest,
        expiresAt: preview.expiresAt,
        revision: current.revision,
        evidence,
      };
    }
    const id = action.action === 'confirm' ? action.previewId : action.collectionId;
    const [stored] = await tx.$queryRawUnsafe(
      `SELECT *,epoch::text,base_revision::text,policy_revision::text,
      catalog_version::text,history_generation::text,history_revision::text,(expires_at>clock_timestamp()) AS fresh
      FROM liekan_traffic_exclusion WHERE website_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      websiteId,
      id,
    );
    if (!stored || stored.epoch !== current.epoch) throw conflict();
    if (action.action === 'confirm') {
      if (
        stored.state !== 'preview' ||
        !stored.fresh ||
        stored.membership_digest !== action.digest ||
        stored.base_revision !== current.revision ||
        [
          'policy_revision',
          'rule_version',
          'catalog_version',
          'history_generation',
          'history_revision',
        ].some(key => stored[key] !== current[key])
      )
        throw conflict();
      const { window, rows } = await windowEvidence(
        tx,
        websiteId,
        stored.window_end,
        current.epoch,
      );
      if (window.computed_at.toISOString() !== stored.evidence.windowComputedAt) throw conflict();
      const members = await tx.$queryRawUnsafe(
        `SELECT m.event_id::text FROM liekan_traffic_exclusion_member m
        JOIN liekan_event_quality q ON q.event_id=m.event_id AND q.website_id=m.website_id
        JOIN website_event e ON e.event_id=q.event_id AND e.website_id=q.website_id
        WHERE m.website_id=$1::uuid AND m.collection_id=$2::uuid AND q.source='browser'
        AND e.event_type IN(1,2,5) AND q.created_at<=$3 AND q.created_at>$4::timestamptz-interval '5 minutes'`,
        websiteId,
        id,
        stored.received_cutoff,
        stored.window_end,
      );
      if (exclusionDigest(members.map((m: any) => m.event_id)) !== action.digest) throw conflict();
      // A changed input set requires a new preview. Late records never silently join an approved set.
      const keys = new Set(stored.evidence.visits.map((v: any) => v.sessionId + ':' + v.visitId));
      const selected = rows.filter(
        (r: any) => r.admissible && keys.has(r.session_id + ':' + r.visit_id),
      );
      if (selected.some((r: any) => !r.identity_available)) throw conflict();
      const ids = selected.map((r: any) => r.event_id);
      if (exclusionDigest(ids) !== action.digest) throw conflict();
      await tx.$executeRawUnsafe(
        "UPDATE liekan_traffic_exclusion SET state='active',confirmed_at=clock_timestamp() WHERE id=$1::uuid",
        id,
      );
    } else {
      if (stored.state !== 'active') throw conflict();
      await tx.$executeRawUnsafe(
        "UPDATE liekan_traffic_exclusion SET state='revoked',revoked_at=clock_timestamp() WHERE id=$1::uuid",
        id,
      );
    }
    const [next] = await tx.$queryRawUnsafe(
      `UPDATE liekan_traffic_governance SET revision=revision+1,updated_at=clock_timestamp()
      WHERE website_id=$1::uuid RETURNING revision::text`,
      websiteId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO liekan_traffic_governance_revision(website_id,revision,actor_id,collection_id,operation)
      VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5)`,
      websiteId,
      next.revision,
      identity.userId,
      id,
      action.action,
    );
    await bumpAnalyticsRevision(tx, 'website', websiteId);
    return { action: action.action, id, revision: next.revision };
  });
  if (action.action !== 'preview') invalidateWebsiteAnalytics(websiteId);
  return result;
}
