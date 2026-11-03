import {
  assessBrowserBehavior,
  BROWSER_RISK_VERSION,
  BROWSER_RISK_WINDOW_LIMIT,
} from '../traffic-quality/behavior';
import { recordKey } from '../warehouse/codec';
import { factInput, warehouseTime } from '../warehouse/fact-input';
import type { FactMutation } from '../warehouse/landing';
import { factRelation } from '../warehouse/read';
import { qualityAuditRelation } from '../warehouse/reporting-relations';
import { type WarehouseRuntime, warehouseRuntime } from '../warehouse/runtime';
import { prepareWarehouseTask, recoverWarehouseTasks } from '../warehouse/tasks';
import {
  warehouseReportMetadata,
  warehouseReportQuery,
  withinWarehouseReport,
} from './warehouse-report-snapshot';

const asDate = (v: string) => new Date(v.includes('T') ? v : `${v.replace(' ', 'T')}Z`);
export async function warehouseRiskWindowEvents(site: string, end: Date) {
  return withinWarehouseReport(async () => {
    const received = await warehouseReportQuery<{ event_id: string; created_at: string }>(
      site,
      `SELECT event_id,created_at FROM ${factRelation('liekan_event_quality', { immutableTimeWindow: { start: 'riskStart', end: 'riskEnd' } })}
      WHERE created_at>{riskStart:DateTime64(6,'UTC')} ORDER BY created_at,event_id LIMIT {riskLimit:UInt32}`,
      {
        riskStart: warehouseTime(new Date(+end - 300000)),
        riskEnd: warehouseTime(end),
        riskLimit: BROWSER_RISK_WINDOW_LIMIT + 1,
      },
    );
    if (!received.length) return [];
    const rows = await warehouseReportQuery<any>(
      site,
      `SELECT event_id,session_id,visit_id,event_type,url_path,received_at,source,
      current_classification AS classification,identity_available,
      coalesce(source='browser' AND event_type IN(1,2,5) AND current_classification<>'automated' AND NOT has(current_reasons,'bot_check_disabled')
      AND ({wh_policy_mode:String}<>'strict' OR current_classification<>'suspected') AND (empty({wh_allowed_hosts:Array(String)}) OR
      (has({wh_allowed_hosts:Array(String)},policy_hostname) AND (isNull(origin_hostname) OR has({wh_allowed_hosts:Array(String)},origin_hostname)))),false) AS admissible
      FROM ${qualityAuditRelation({ recordKeysParameter: 'riskKeys' })} ORDER BY received_at,event_id`,
      { riskKeys: received.map(r => JSON.stringify([r.event_id])) },
    );
    const byID = new Map(rows.map(r => [r.event_id, r]));
    // Missing parents still consume input budget, matching the historical observer.
    return received.map(r => ({
      event_id: r.event_id,
      session_id: null,
      visit_id: null,
      event_type: null,
      url_path: null,
      source: null,
      classification: null,
      identity_available: false,
      admissible: false,
      ...byID.get(r.event_id),
      received_at: asDate(r.created_at),
      observed_at: asDate(r.created_at),
    }));
  });
}
export async function processWarehouseBrowserRisk(suppliedRuntime?: WarehouseRuntime) {
  const runtime = suppliedRuntime ?? (await warehouseRuntime());
  await recoverWarehouseTasks(runtime);
  await runtime.db.transaction(tx =>
    tx.query(
      `INSERT INTO liekan_browser_risk_state(website_id,epoch,next_window,rule_version)
    SELECT w.website_id,coalesce(l.epoch,1),date_trunc('minute',now())+interval '1 minute',$1 FROM liekan_warehouse_site w
    JOIN website site ON site.website_id=w.website_id AND site.deleted_at IS NULL
    LEFT JOIN liekan_log_state l ON l.website_id=w.website_id
    WHERE w.state='active' AND w.publication>0 AND NOT EXISTS(SELECT 1 FROM liekan_browser_risk_state s WHERE s.website_id=w.website_id)
    ORDER BY w.website_id LIMIT 10 ON CONFLICT DO NOTHING`,
      [BROWSER_RISK_VERSION],
    ),
  );
  const candidates = await runtime.db.read<{
    website_id: string;
    epoch: string;
    next_window: Date;
  }>(`SELECT s.website_id,s.epoch,s.next_window FROM liekan_browser_risk_state s
    JOIN liekan_warehouse_site w ON w.website_id=s.website_id AND w.state='active'
    WHERE s.next_attempt_at<=now() AND s.next_window<=date_trunc('minute',now())-interval '2 minutes'
      AND NOT EXISTS(SELECT 1 FROM liekan_warehouse_task t WHERE t.website_id=s.website_id AND t.kind='browser-risk' AND t.status IN('pending','confirmed'))
    ORDER BY s.computed_at NULLS FIRST,s.website_id LIMIT 10`);
  for (const candidate of candidates) {
    const site = candidate.website_id;
    try {
      await withinWarehouseReport(async () => {
        const metadata = await warehouseReportMetadata(site),
          state = await runtime.resource(site, 'website');
        if (
          state.epoch !== metadata.boundary.epoch ||
          state.deletion_revision !== metadata.boundary.deletionRevision ||
          state.policy_revision !== String(metadata.population.policyRevision)
        )
          throw new Error('warehouse-risk-source-changed');
        if (String(metadata.population.epoch) !== candidate.epoch) {
          await runtime.db.transaction(tx =>
            tx.query('DELETE FROM liekan_browser_risk_state WHERE website_id=$1 AND epoch=$2', [
              site,
              candidate.epoch,
            ]),
          );
          return;
        }
        const end = new Date(
          Math.max(
            +candidate.next_window,
            Math.floor((Date.now() - 30 * 86400000) / 60000) * 60000,
          ),
        );
        const rows = await warehouseRiskWindowEvents(site, end),
          complete = rows.length <= BROWSER_RISK_WINDOW_LIMIT;
        const pageviews = rows.slice(0, BROWSER_RISK_WINDOW_LIMIT).filter(r => r.event_type === 1),
          visits = new Map<string, typeof pageviews>();
        for (const row of pageviews) {
          const key = `${row.session_id}:${row.visit_id}`;
          const group = visits.get(key) ?? [];
          group.push(row);
          visits.set(key, group);
        }
        const findings = [...visits.values()].map(group => ({
          session: group[0].session_id,
          visit: group[0].visit_id,
          ...assessBrowserBehavior(
            group.map(r => ({ observedAt: +r.observed_at, path: r.url_path })),
            complete,
          ),
        }));
        const flagged = findings.filter(f => f.state === 'review');
        const existing = await warehouseReportQuery<any>(
          site,
          `SELECT website_id,window_end,session_id,visit_id,reasons,features FROM ${factRelation('liekan_browser_risk')}
          WHERE window_end={riskWindow:DateTime64(6,'UTC')}`,
          { riskWindow: warehouseTime(end) },
        );
        const facts: FactMutation[] = flagged.map(f => ({
          family: 'liekan_browser_risk',
          row: factInput('liekan_browser_risk', {
            website_id: site,
            window_end: end,
            session_id: f.session,
            visit_id: f.visit,
            reasons: f.reasons,
            features: f.features,
          }),
        }));
        const live = new Set(facts.map(f => recordKey(f.family, f.row)));
        for (const r of existing) {
          const row = factInput('liekan_browser_risk', r);
          if (!live.has(recordKey('liekan_browser_risk', row)))
            facts.push({ family: 'liekan_browser_risk', row, deleted: true });
        }
        let next = new Date(+end + 60000);
        if (!rows.length) {
          const [first] = await warehouseReportQuery<{ time: string | null }>(
            site,
            `SELECT if(count()>0,toString(min(created_at)),NULL) AS time FROM ${factRelation('liekan_event_quality')}
          WHERE created_at>{riskEnd:DateTime64(6,'UTC')}`,
            { riskEnd: warehouseTime(end) },
          );
          if (first.time) next = new Date(Math.floor(+asDate(first.time) / 60000) * 60000 + 60000);
        }
        await prepareWarehouseTask(
          runtime,
          state,
          {
            kind: 'browser-risk',
            windowEnd: end.toISOString(),
            logEpoch: candidate.epoch,
            ruleVersion: BROWSER_RISK_VERSION,
            coverage: complete ? 'observed' : 'partial',
            events: pageviews.length,
            visits: visits.size,
            insufficient: findings.filter(f => f.state === 'insufficient').length,
            flagged: flagged.length,
            nextBefore: candidate.next_window.toISOString(),
            nextAfter: next.toISOString(),
          },
          facts,
        );
      });
    } catch {
      await runtime.db
        .transaction(tx =>
          tx.query(
            "UPDATE liekan_browser_risk_state SET next_attempt_at=clock_timestamp()+interval '1 minute',error_code='analysis-unavailable' WHERE website_id=$1 AND epoch=$2 AND next_window=$3",
            [site, candidate.epoch, candidate.next_window],
          ),
        )
        .catch(() => {});
    }
  }
  await runtime.db.transaction(tx =>
    tx.query(
      "DELETE FROM liekan_browser_risk_window WHERE ctid IN(SELECT ctid FROM liekan_browser_risk_window WHERE window_end<now()-interval '30 days' LIMIT 5000)",
    ),
  );
}

export async function warehouseBrowserRiskReport(site: string, parameters: URLSearchParams) {
  const { parseQualityRange, qualityReadTransaction } = await import('./traffic-quality');
  const { warehouseQualityTotals } = await import('./warehouse-traffic-quality');
  const { riskRelation } = await import('../warehouse/risk-proof');
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
    const p = {
      riskRule: BROWSER_RISK_VERSION,
      riskEpoch: String(metadata.population.epoch),
      riskStart: warehouseTime(new Date(range.startAt)),
      riskEnd: warehouseTime(new Date(range.endAt)),
      riskRetained: warehouseTime(new Date(Date.now() - 30 * 86400000)),
      riskClassification: range.classification ?? null,
      riskSource: range.source ?? null,
      riskHost: range.hostname ?? null,
      auditStart: warehouseTime(new Date(range.startAt)),
      auditEnd: warehouseTime(new Date(range.endAt)),
    };
    const scope = `({riskClassification:Nullable(String)} IS NULL OR coalesce(e.classification,'unknown')={riskClassification:Nullable(String)})
      AND ({riskSource:Nullable(String)} IS NULL OR e.source={riskSource:Nullable(String)})
      AND ({riskHost:Nullable(String)} IS NULL OR e.hostname={riskHost:Nullable(String)} OR e.normalized_hostname={riskHost:Nullable(String)})`;
    const risks = `(SELECT * FROM ${riskRelation()} WHERE window_end>={riskRetained:DateTime64(6,'UTC')})`;
    const findings = await warehouseReportQuery<any>(
      site,
      `SELECT DISTINCT r.session_id AS sessionId,r.visit_id AS visitId,r.window_end AS windowEnd,r.reasons AS reasons,r.features AS features,r.computed_at AS computedAt
      FROM ${risks} r INNER JOIN ${qualityAuditRelation({})} e ON e.session_id=r.session_id AND e.visit_id=r.visit_id
        AND e.received_at<=r.window_end AND e.received_at>r.window_end-INTERVAL 5 MINUTE
      WHERE r.window_end BETWEEN {riskStart:DateTime64(6,'UTC')} AND {riskEnd:DateTime64(6,'UTC')} AND e.event_type=1 AND ${scope}
      ORDER BY windowEnd DESC,sessionId,visitId LIMIT 100`,
      p,
    );
    const { qualityIncludedPredicate } = await import('../warehouse/reporting-relations');
    const [impact] = await warehouseReportQuery<{ flaggedPV: string; remainingUV: string }>(
      site,
      `SELECT countIf(flagged) AS flaggedPV,uniqExactIf(session_id,NOT flagged) AS remainingUV FROM
      (SELECT e.event_id AS event_id,e.session_id AS session_id,max(coalesce(isNotNull(r.visit_id) AND e.received_at<=r.window_end AND e.received_at>r.window_end-INTERVAL 5 MINUTE,false)) AS flagged
       FROM (SELECT * FROM ${qualityAuditRelation()} WHERE ${qualityIncludedPredicate()}) e LEFT JOIN ${risks} r
         ON r.session_id=e.session_id AND r.visit_id=e.visit_id
       WHERE e.event_type NOT IN(2,5) AND ${scope} GROUP BY e.event_id,e.session_id)`,
      p,
    );
    const totals = await warehouseQualityTotals(site, range),
      flaggedPV = Number(impact.flaggedPV),
      remainingUV = Number(impact.remainingUV);
    if (!Number.isSafeInteger(flaggedPV) || !Number.isSafeInteger(remainingUV))
      throw new Error('warehouse-counter-out-of-range');
    return {
      available: true,
      mode: 'observe',
      ruleVersion: BROWSER_RISK_VERSION,
      state: state || null,
      coverage,
      findings: findings.map(r => ({
        ...r,
        features: JSON.parse(r.features),
        windowEnd: asDate(r.windowEnd),
        computedAt: r.computedAt ? asDate(r.computedAt) : null,
      })),
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
