import { warehouseEnabled } from '@/lib/liekan/warehouse/authority-routing';
import { assertTransitionMaintenance } from './warehouse-maintenance';
import {
  assessBrowserBehavior,
  BROWSER_RISK_VERSION,
  BROWSER_RISK_WINDOW_LIMIT,
} from '../traffic-quality/behavior';
import { transaction } from './server';
import { parseQualityRange, qualityReadTransaction, qualityTotals } from './traffic-quality';

/** Bounded jobs hold website before progress locks, matching reset/delete lock order. */
export async function processBrowserRisk() {
  if (warehouseEnabled())
    return (await import('./warehouse-browser-risk')).processWarehouseBrowserRisk();
  if (process.env.CLICKHOUSE_URL) return;
  // Lock a bounded set of live websites before FK writes; resets never stall other sites.
  await transaction(async tx => {
    await assertTransitionMaintenance(tx, 'risk');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
    await tx.$executeRawUnsafe(
      `WITH candidates AS MATERIALIZED (
         SELECT w.website_id FROM website w WHERE w.deleted_at IS NULL
         AND NOT EXISTS(SELECT 1 FROM liekan_browser_risk_state s WHERE s.website_id=w.website_id)
         AND EXISTS(SELECT 1 FROM liekan_event_quality q WHERE q.website_id=w.website_id AND q.created_at>now()-interval '5 minutes')
         ORDER BY w.website_id LIMIT 10 FOR SHARE OF w SKIP LOCKED
       ) INSERT INTO liekan_browser_risk_state(website_id,epoch,next_window,rule_version)
       SELECT c.website_id,COALESCE(l.epoch,1),date_trunc('minute',now())+interval '1 minute',$1
       FROM candidates c LEFT JOIN liekan_log_state l ON l.website_id=c.website_id ON CONFLICT DO NOTHING`,
      BROWSER_RISK_VERSION,
    );
  }).catch(() => {}); // Existing sites still progress when concurrent initialization retries.
  const attempted: string[] = [];
  for (let batch = 0; batch < 10; batch++) {
    let selected: string | undefined;
    let selectedEpoch: number | bigint | undefined;
    let selectedWindow: Date | undefined;
    try {
      const processed = await transaction(async tx => {
        await assertTransitionMaintenance(tx, 'risk');
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout='15s'");
        const [candidate] = await tx.$queryRawUnsafe(
          `SELECT s.website_id FROM liekan_browser_risk_state s JOIN website w ON w.website_id=s.website_id
         WHERE w.deleted_at IS NULL AND s.next_attempt_at<=now() AND NOT(s.website_id=ANY($1::uuid[])) AND s.next_window<=date_trunc('minute',now())-interval '2 minutes'
         AND EXISTS(SELECT 1 FROM liekan_event_quality q WHERE q.website_id=s.website_id AND q.created_at>s.next_window-interval '5 minutes')
         ORDER BY s.computed_at NULLS FIRST,s.website_id LIMIT 1`,
          attempted,
        );
        if (!candidate) return false;
        const id = candidate.website_id;
        selected = id;
        attempted.push(id);
        const website = await tx.$queryRawUnsafe(
          'SELECT website_id FROM website WHERE website_id=$1::uuid AND deleted_at IS NULL FOR SHARE SKIP LOCKED',
          id,
        );
        if (!website.length) return true;
        const [state] = await tx.$queryRawUnsafe(
          "SELECT * FROM liekan_browser_risk_state WHERE website_id=$1::uuid AND next_attempt_at<=now() AND next_window<=date_trunc('minute',now())-interval '2 minutes' FOR UPDATE SKIP LOCKED",
          id,
        );
        if (!state) return true;
        selectedEpoch = state.epoch;
        selectedWindow = state.next_window;
        const [epoch] = await tx.$queryRawUnsafe(
          'SELECT epoch::text FROM liekan_log_state WHERE website_id=$1::uuid',
          id,
        );
        if (String(state.epoch) !== (epoch?.epoch || '1')) {
          await tx.$executeRawUnsafe(
            'DELETE FROM liekan_browser_risk_state WHERE website_id=$1::uuid',
            id,
          );
          return true;
        }
        // Expired windows remain outside observed coverage. Never invent a historical verdict.
        const end = new Date(
          Math.max(+state.next_window, Math.floor((Date.now() - 30 * 86400000) / 60000) * 60000),
        );
        const rows = await tx.$queryRawUnsafe(
          `WITH candidates AS MATERIALIZED (
           SELECT event_id,created_at FROM liekan_event_quality
           WHERE website_id=$1::uuid AND created_at>$2::timestamptz-interval '5 minutes' AND created_at<=$2
           ORDER BY created_at,event_id LIMIT $3
         )
         SELECT e.session_id,e.visit_id,e.url_path,e.event_type,q.created_at AS observed_at
         FROM candidates q LEFT JOIN LATERAL (
           SELECT session_id,visit_id,url_path,event_type FROM website_event e
           WHERE e.event_id=q.event_id AND e.website_id=$1::uuid LIMIT 1
         ) e ON true ORDER BY q.created_at,q.event_id`,
          id,
          end,
          BROWSER_RISK_WINDOW_LIMIT + 1,
        );
        const complete = rows.length <= BROWSER_RISK_WINDOW_LIMIT;
        // The input budget covers all event types; behavior uses only the sampled pageviews.
        const pageviews = rows
          .slice(0, BROWSER_RISK_WINDOW_LIMIT)
          .filter(row => row.event_type === 1);
        const visits = new Map<string, any[]>();
        for (const row of pageviews) {
          const key = row.session_id + ':' + row.visit_id;
          const group = visits.get(key) || [];
          group.push(row);
          visits.set(key, group);
        }
        const findings = [...visits.values()].map(group => ({
          session: group[0].session_id,
          visit: group[0].visit_id,
          ...assessBrowserBehavior(
            group.map(e => ({ observedAt: +e.observed_at, path: e.url_path })),
            complete,
          ),
        }));
        await tx.$executeRawUnsafe(
          `INSERT INTO liekan_browser_risk_window(website_id,window_end,epoch,rule_version,coverage,events,visits,insufficient,flagged)
         VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(website_id,window_end) DO UPDATE SET epoch=EXCLUDED.epoch,rule_version=EXCLUDED.rule_version,
         coverage=EXCLUDED.coverage,events=EXCLUDED.events,visits=EXCLUDED.visits,insufficient=EXCLUDED.insufficient,flagged=EXCLUDED.flagged,computed_at=clock_timestamp()`,
          id,
          end,
          state.epoch,
          BROWSER_RISK_VERSION,
          complete ? 'observed' : 'partial',
          pageviews.length,
          visits.size,
          findings.filter(f => f.state === 'insufficient').length,
          findings.filter(f => f.state === 'review').length,
        );
        await tx.$executeRawUnsafe(
          'DELETE FROM liekan_browser_risk WHERE website_id=$1::uuid AND window_end=$2',
          id,
          end,
        );
        const flagged = findings.filter(f => f.state === 'review');
        if (flagged.length)
          await tx.$executeRawUnsafe(
            `INSERT INTO liekan_browser_risk(website_id,window_end,session_id,visit_id,reasons,features)
         SELECT $1::uuid,$2,session::uuid,visit::uuid,reasons,features FROM jsonb_to_recordset($3::jsonb) AS r(session text,visit text,reasons text[],features jsonb)`,
            id,
            end,
            JSON.stringify(flagged),
          );
        let next = new Date(+end + 60000);
        if (!rows.length) {
          const [first] = await tx.$queryRawUnsafe(
            'SELECT created_at FROM liekan_event_quality WHERE website_id=$1::uuid AND created_at>$2 ORDER BY created_at LIMIT 1',
            id,
            end,
          );
          if (first) next = new Date(Math.floor(+first.created_at / 60000) * 60000 + 60000);
        }
        await tx.$executeRawUnsafe(
          'UPDATE liekan_browser_risk_state SET next_window=$2,computed_at=clock_timestamp(),next_attempt_at=clock_timestamp(),error_code=NULL,rule_version=$3 WHERE website_id=$1::uuid AND epoch=$4',
          id,
          next,
          BROWSER_RISK_VERSION,
          state.epoch,
        );
        return true;
      });
      if (!processed) break;
    } catch {
      if (selected && selectedEpoch !== undefined && selectedWindow)
        await transaction(async tx => {
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
          await tx.$executeRawUnsafe(
            "UPDATE liekan_browser_risk_state SET next_attempt_at=clock_timestamp()+interval '1 minute',error_code='analysis-unavailable' WHERE website_id=$1::uuid AND epoch=$2 AND next_window=$3",
            selected,
            selectedEpoch,
            selectedWindow,
          );
        }).catch(() => {});
    }
  }
  await transaction(async tx => {
    for (const [table, column] of [
      ['liekan_collection_diagnostic', 'bucket'],
      ['liekan_browser_risk_window', 'window_end'],
    ]) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${column}<now()-interval '30 days' LIMIT 5000)`,
      );
    }
  });
}
export async function browserRiskReport(websiteId: string, parameters: URLSearchParams) {
  if (warehouseEnabled())
    return (await import('./warehouse-browser-risk')).warehouseBrowserRiskReport(
      websiteId,
      parameters,
    );
  if (process.env.CLICKHOUSE_URL)
    return { available: false, reason: '行为风险观察当前支持 PostgreSQL' };
  // Observations retain whole visit windows; audit paths must not narrow their totals.
  const riskParameters = new URLSearchParams(parameters);
  riskParameters.delete('path');
  const range = parseQualityRange(riskParameters);
  return qualityReadTransaction(async tx => {
    const [state] = await tx.$queryRawUnsafe(
      'SELECT started_at AS "startedAt",computed_at AS "computedAt",next_window AS "nextWindow",error_code AS "errorCode",rule_version AS "ruleVersion" FROM liekan_browser_risk_state WHERE website_id=$1::uuid',
      websiteId,
    );
    const window = [
      websiteId,
      new Date(range.startAt),
      new Date(range.endAt),
      BROWSER_RISK_VERSION,
    ];
    const [coverage] = await tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS windows,COUNT(*) FILTER(WHERE coverage='partial')::int AS "partialWindows",
       MIN(window_end) AS "firstWindow",MAX(window_end) AS "lastWindow"
       FROM liekan_browser_risk_window WHERE website_id=$1::uuid AND window_end BETWEEN $2 AND $3 AND rule_version=$4`,
      ...window,
    );
    const findings = await tx.$queryRawUnsafe(
      `SELECT r.session_id::text AS "sessionId",r.visit_id::text AS "visitId",r.window_end AS "windowEnd",r.reasons,r.features,w.computed_at AS "computedAt"
       FROM liekan_browser_risk r JOIN liekan_browser_risk_window w USING(website_id,window_end)
       WHERE r.website_id=$1::uuid AND r.window_end BETWEEN $2 AND $3 AND w.rule_version=$4 AND w.coverage='observed'
       AND EXISTS(SELECT 1 FROM website_event e JOIN liekan_event_quality q ON q.event_id=e.event_id AND q.website_id=e.website_id
         WHERE e.website_id=r.website_id AND e.session_id=r.session_id AND e.visit_id=r.visit_id AND e.event_type=1
         AND q.created_at<=r.window_end AND q.created_at>r.window_end-interval '5 minutes'
         AND ($5::text IS NULL OR COALESCE(q.classification,'unknown')=$5) AND ($6::text IS NULL OR q.source=$6)
         AND ($7::text IS NULL OR e.hostname=$7 OR q.hostname=$7))
       ORDER BY r.window_end DESC,r.session_id,r.visit_id LIMIT 100`,
      ...window,
      range.classification || null,
      range.source || null,
      range.hostname || null,
    );
    const totals = await qualityTotals(tx, websiteId, range);
    const [impact] = await tx.$queryRawUnsafe(
      `WITH population AS (
        SELECT e.session_id,EXISTS(SELECT 1 FROM liekan_browser_risk r JOIN liekan_browser_risk_window w USING(website_id,window_end)
          WHERE r.website_id=e.website_id AND r.session_id=e.session_id AND r.visit_id=e.visit_id
          AND w.rule_version=$4 AND w.coverage='observed' AND q.created_at<=r.window_end AND q.created_at>r.window_end-interval '5 minutes') AS flagged
        FROM liekan_effective_website_event e LEFT JOIN liekan_event_quality q ON q.event_id=e.event_id AND q.website_id=e.website_id
        WHERE e.website_id=$1::uuid AND e.created_at BETWEEN $2 AND $3 AND e.event_type NOT IN(2,5)
        AND ($5::text IS NULL OR COALESCE(q.classification,'unknown')=$5) AND ($6::text IS NULL OR q.source=$6)
        AND ($7::text IS NULL OR e.hostname=$7 OR q.hostname=$7))
       SELECT COUNT(*) FILTER(WHERE flagged)::float8 AS "flaggedPV",COUNT(DISTINCT session_id) FILTER(WHERE NOT flagged)::float8 AS "remainingUV" FROM population`,
      ...window,
      range.classification || null,
      range.source || null,
      range.hostname || null,
    );
    return {
      available: true,
      mode: 'observe',
      ruleVersion: BROWSER_RISK_VERSION,
      state: state || null,
      coverage,
      findings,
      impact: {
        includedPV: totals.includedPV,
        includedUV: totals.includedUV,
        flaggedPV: impact.flaggedPV,
        fullyExcludedUV: totals.includedUV === null ? null : totals.includedUV - impact.remainingUV,
      },
      timeBasis: 'server-received',
      range: { startAt: range.startAt, endAt: range.endAt },
      retentionDays: 30,
    };
  });
}
