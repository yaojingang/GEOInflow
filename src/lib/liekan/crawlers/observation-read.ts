import { warehouseEvidenceRows } from '../upstream/warehouse-evidence-table';
import { warehouseEnabled } from '../warehouse/authority-routing';
import { warehouseObservationFacts } from '../upstream/warehouse-evidence-queries';
import { evidenceValue } from '../contracts/crawler-metrics';
import { BROWSER_RISK_VERSION } from '../traffic-quality/behavior';
import { OBSERVATION_VERSION } from '../upstream/collection-observation';
import type { AiTx } from '../upstream/ai-db';
import { databaseSchema } from '../upstream/database-schema';
import { evidenceMeta, type EvidenceInputs } from './evidence-read';

import { parseObservationQuery } from './observation-window';
export { parseObservationQuery } from './observation-window';
export async function readObservations(
  tx: AiTx,
  websiteId: string,
  p: ReturnType<typeof parseObservationQuery>,
  input: EvidenceInputs,
) {
  // Reception diagnostics retain raw session presence; the eligible subset is selected explicitly below.
  // Quality.created_at is reception time, independent of the event's business timestamp.
  const schema = databaseSchema();
  const args = [
    websiteId,
    new Date(Math.max(p.startAt, Date.now() - 30 * 86400000)),
    new Date(p.endAt),
  ];
  const population = `FROM liekan_raw_website_event e JOIN "${schema}"."session" s ON s.session_id=e.session_id AND s.website_id=e.website_id JOIN liekan_event_quality q ON q.website_id=e.website_id AND q.event_id=e.event_id
    LEFT JOIN liekan_event_environment env ON env.website_id=e.website_id AND env.event_id=e.event_id
    LEFT JOIN liekan_event_observation o ON o.website_id=e.website_id AND o.event_id=e.event_id
    WHERE e.website_id=$1::uuid AND e.event_type=1 AND q.source IN('browser','legacy_override')
      AND coalesce(o.received_at,q.created_at)>=$2 AND coalesce(o.received_at,q.created_at)<$3
      ${p.subset === 'eligible' ? 'AND EXISTS(SELECT 1 FROM website_event eligible WHERE eligible.event_id=e.event_id AND eligible.website_id=e.website_id)' : ''}`;
  const warehouseFacts = warehouseEnabled()
    ? await warehouseObservationFacts(websiteId, p, input, args[1] as Date)
    : null;
  const rows = warehouseFacts
    ? warehouseFacts.rows
    : await tx.query(
        `SELECT coalesce(s.browser,'unknown') AS browser,q.source,q.classification,coalesce(o.version,'not_collected') AS version,
    o.features,count(*)::float8 AS pv,count(distinct e.session_id)::float8 AS uv,
    count(*)<20 AS "smallSample",min(e.created_at) AS "firstEventAt",max(e.created_at) AS "lastEventAt"
    ${population} GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,o.features::text LIMIT 100001`,
        ...args,
      );
  const [behavior] = warehouseFacts
    ? [warehouseFacts.behavior]
    : await tx.query(
        `SELECT count(*) FILTER(WHERE EXISTS(
      SELECT 1 FROM liekan_browser_risk r JOIN liekan_browser_risk_window w USING(website_id,window_end)
      WHERE r.website_id=e.website_id AND r.session_id=e.session_id AND r.visit_id=e.visit_id
        AND w.epoch=$4 AND w.rule_version=$5 AND w.coverage='observed'
        AND q.created_at<=r.window_end AND q.created_at>r.window_end-interval '5 minutes'
    ))::float8 AS "flaggedPv",
    count(distinct e.session_id) FILTER(WHERE EXISTS(
      SELECT 1 FROM liekan_browser_risk r JOIN liekan_browser_risk_window w USING(website_id,window_end)
      WHERE r.website_id=e.website_id AND r.session_id=e.session_id AND r.visit_id=e.visit_id
        AND w.epoch=$4 AND w.rule_version=$5 AND w.coverage='observed'
        AND q.created_at<=r.window_end AND q.created_at>r.window_end-interval '5 minutes'
    ))::float8 AS "flaggedUv" ${population}`,
        ...args,
        input.baseline.epoch,
        BROWSER_RISK_VERSION,
      );
  const [totals] = warehouseFacts
    ? [warehouseFacts.totals]
    : await tx.query(
        `SELECT count(*)::float8 AS pv,count(distinct e.session_id)::float8 AS uv,
    count(distinct(e.visit_id,e.session_id))::float8 AS visits,count(o.event_id)::float8 AS observed,
    count(*) FILTER(WHERE env.scope='browser' AND env.identity_available)::float8 AS "identityQualifiedPv",
    count(distinct e.session_id) FILTER(WHERE env.scope='browser' AND env.identity_available)::float8 AS "identityQualifiedVisitors",
    array_remove(array_agg(distinct env.identity_version ORDER BY env.identity_version),NULL) AS "identityVersions",
    count(*) FILTER(WHERE o.event_id IS NULL)::float8 AS "notCollected",count(*) FILTER(WHERE o.version=$4)::float8 AS "currentVersion"
    ${population}`,
        ...args,
        OBSERVATION_VERSION,
      );
  const observationIdentity = {
    version: 'received-browser-identity-v1' as const,
    timeBasis: 'received_at' as const,
    population: p.subset === 'raw' ? ('raw_public_pv' as const) : ('eligible_public_pv' as const),
    range: { startAt: +args[1], endAt: p.endAt, timezone: p.timezone, endExclusive: true as const },
    status: !totals.pv
      ? ('empty' as const)
      : totals.identityQualifiedPv === totals.pv
        ? ('complete' as const)
        : totals.identityQualifiedPv
          ? ('partial' as const)
          : ('unavailable' as const),
    totalPV: totals.pv,
    qualifiedPV: totals.identityQualifiedPv,
    qualifiedVisitors: totals.identityQualifiedVisitors,
    coverage: totals.pv ? totals.identityQualifiedPv / totals.pv : null,
    versions: (totals.identityVersions || []).slice(0, 32),
    versionsTruncated: (totals.identityVersions || []).length > 32,
  };
  const identityReady = ['complete', 'empty'].includes(observationIdentity.status);
  const { identityQualifiedPv, identityQualifiedVisitors, identityVersions, ...counts } = totals;
  const [state] = await tx.query(
    'SELECT epoch,first_received_at AS "firstReceivedAt",last_received_at AS "lastReceivedAt",last_version AS "lastVersion",pruned_before AS "prunedBefore" FROM liekan_observation_state WHERE website_id=$1::uuid',
    websiteId,
  );
  const fields = Object.fromEntries(
    ['accept', 'language', 'site', 'mode', 'dest'].map(field => {
      const samples = warehouseFacts
        ? Number(warehouseFacts.fieldSamples[field])
        : rows.reduce((n, row) => n + (row.features?.[field]?.state === 'present' ? row.pv : 0), 0);
      return [
        field,
        evidenceValue(
          totals.pv ? samples / totals.pv : null,
          samples,
          totals.pv,
          totals.pv ? (samples === totals.pv ? 'available' : 'partial') : 'unknown',
          totals.pv ? null : 'no_received_pv',
          'received_at',
        ),
      ];
    }),
  );
  return {
    meta: {
      ...evidenceMeta(p as any, input),
      timeBasis: 'received_at',
      population: p.subset === 'raw' ? 'raw_public_pv' : 'eligible_public_pv',
      observationVersion: OBSERVATION_VERSION,
      observationIdentity,
      observationState: state?.epoch === input.baseline.epoch ? state : null,
      historicalReception: 'unknown',
    },
    rows: rows.map(row => ({ ...row, uv: identityReady ? row.uv : null })),
    ...(warehouseFacts ? { [warehouseEvidenceRows]: warehouseFacts.table } : {}),
    totals: {
      ...counts,
      ...behavior,
      uv: identityReady ? totals.uv : null,
      visits: identityReady ? totals.visits : null,
      flaggedUv: identityReady ? behavior.flaggedUv : null,
    },
    coverage: fields,
    state: !totals.pv ? 'unknown' : totals.currentVersion !== totals.pv ? 'partial' : 'available',
    reasonCode: !totals.pv
      ? 'no_received_pv'
      : totals.currentVersion !== totals.pv
        ? 'observation_missing_or_mixed'
        : null,
  };
}
