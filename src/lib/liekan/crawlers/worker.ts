import { reconcileFindingWorkflow } from './workflow-lifecycle';
import { randomUUID } from 'node:crypto';
import type {
  CrawlerHttpBotId,
  CrawlerRequestCounts,
  CrawlerObservationQuality,
} from '../contracts/crawlers';
import { getActiveCrawlerIds } from './registry';
import { acquireCrawlerLease, releaseCrawlerLease } from '../crawler-control/leases';
import { crawlerTransaction } from '../upstream/crawler-access';
import { analyticsCache, websiteCacheTag } from '../upstream/query-cache';
import { crawlerBase, crawlerCountColumns, crawlerWindowQuality } from './analysis';
import { crawlerIntentionalBlock, crawlerOwnedBlock } from './execution';
import { coverageRecovery } from './coverage-recovery';
import { completeHourWindow, evaluateCrawlerRisks, transitionRisk } from './risks';
import { withPublishedRegistry } from '../upstream/crawler-registry-context';
import { registryVersionIsCurrent } from '../upstream/crawler-registry';
import type { AiTx } from '../upstream/ai-db';
import {
  warehouseEnabled,
  warehouseTransitionEnabled,
  withinWarehouseAuthority,
} from '../warehouse/authority-routing';
import { WarehouseConflict } from '../warehouse/control-db';
import { withinWarehouseReport, warehouseReportMetadata, warehouseControlFingerprint } from '../upstream/warehouse-report-snapshot';
import { warehouseControlRead } from '../upstream/warehouse-control-read';
import { readReportingMetadata } from '../warehouse/reporting-context';
import { warehouseCrawlerHours, warehouseCrawlerHourMetadata, warehouseCrawlerExpected, warehouseCrawlerCoverage } from '../upstream/warehouse-crawler-queries';

const DAY = 86_400_000,
  HOUR = 3_600_000;
interface HourCounts extends CrawlerRequestCounts {
  botId: CrawlerHttpBotId;
  hour: Date;
  intentional: number;
  mismatches: number;
  sensitive: number;
}
interface AnalysisAuthority {
  authority: 'postgres' | 'clickhouse' | 'frozen';
  revision: string;
  installation_id: string;
}
async function readAnalysisAuthority(): Promise<AnalysisAuthority | undefined> {
  if (!warehouseTransitionEnabled()) return;
  const [authority] = await crawlerTransaction(tx =>
    tx.query<AnalysisAuthority>(
      'SELECT authority,revision::text,installation_id::text FROM liekan_warehouse_installation WHERE id=1',
    ),
  );
  if (!authority || authority.authority !== (warehouseEnabled() ? 'clickhouse' : 'postgres'))
    throw new WarehouseConflict('warehouse-authority-changed');
  return authority;
}
async function analysisAuthorityIsCurrent(tx: AiTx, expected?: AnalysisAuthority) {
  if (!expected) return true;
  // The cutover takes an exclusive installation lock. Hold its shared lock
  // through the result/failure write so a return-time check cannot come too late.
  const [current] = await tx.query<AnalysisAuthority>(
    'SELECT authority,revision::text,installation_id::text FROM liekan_warehouse_installation WHERE id=1 FOR SHARE',
  );
  return (
    current?.authority === expected.authority &&
    current.revision === expected.revision &&
    current.installation_id === expected.installation_id
  );
}
export async function recomputeCrawlerRisks(websiteId: string, now = Date.now()) {
  return withinWarehouseAuthority(() =>
    withPublishedRegistry(async catalog =>
      recomputeCrawlerRisksSnapshot(
        websiteId,
        now,
        catalog.version,
        undefined,
        await readAnalysisAuthority(),
      ),
    ),
  );
}
async function analysisLeaseIsCurrent(tx: AiTx, workerId: string) {
  const [lease] = await tx.query(
    "SELECT expires_at>clock_timestamp() AS leased FROM liekan_crawler_lease WHERE name='analysis' AND owner=$1::uuid FOR UPDATE",
    workerId,
  );
  return lease?.leased === true;
}
async function recomputeCrawlerRisksSnapshot(
  websiteId: string,
  now: number,
  catalogVersion: string,
  workerId?: string,
  authority?: AnalysisAuthority,
) {
  const window = completeHourWindow(now);
  if (warehouseEnabled()) await crawlerTransaction(tx => tx.execute(
    `INSERT INTO liekan_crawler_catalog_snapshot(website_id,snapshot_at,paths)
      SELECT $1::uuid,date_trunc('day',now()),coalesce(jsonb_agg(path ORDER BY path),'[]'::jsonb) FROM liekan_catalog WHERE website_id=$1::uuid ON CONFLICT DO NOTHING`, websiteId,
  ));
  const facts = await (warehouseEnabled() ? warehouseCrawlerRead : crawlerTransaction)(
    async tx => {
      const [state] = await tx.query(
        'SELECT epoch,data_revision FROM liekan_log_state WHERE website_id=$1::uuid',
        websiteId,
      );
      const [configuration] = await tx.query(
        'SELECT critical_paths FROM liekan_crawler_state WHERE website_id=$1::uuid',
        websiteId,
      );
      const [previousAnalysis] = await tx.query(
        "SELECT computed_at,data_revision,window_end,quality->>'catalogVersion' AS catalog_version FROM liekan_crawler_analysis_state WHERE website_id=$1::uuid",
        websiteId,
      );
      if (!warehouseEnabled()) await tx.execute(
        `INSERT INTO liekan_crawler_catalog_snapshot(website_id,snapshot_at,paths)
      SELECT $1::uuid,date_trunc('day',now()),coalesce(jsonb_agg(path ORDER BY path),'[]'::jsonb) FROM liekan_catalog WHERE website_id=$1::uuid
      ON CONFLICT DO NOTHING`,
        websiteId,
      );
      const rows = warehouseEnabled() ? await warehouseCrawlerHours(tx,websiteId,window.endAt-14*DAY,window.endAt) as HourCounts[] : await tx.query<HourCounts>(
        `SELECT e.crawler_id AS "botId",date_trunc('hour',l.created_at) AS hour,${crawlerCountColumns},
      count(*) FILTER(WHERE verification='range_mismatch')::float8 AS mismatches,
      count(*) FILTER(WHERE path ~ '^/(\\.env($|[./])|\\.git($|/)|wp-config[.]php$)')::float8 AS sensitive,
      count(*) FILTER(WHERE status IN(403,429) AND ${crawlerIntentionalBlock})::float8 AS intentional
      ${crawlerBase} AND e.crawler_id IS NOT NULL GROUP BY 1,2 ORDER BY hour`,
        websiteId,
        new Date(window.endAt - 14 * DAY),
        new Date(window.endAt),
      );
      const quality = await crawlerWindowQuality(
        tx,
        websiteId,
        window.startAt,
        window.endAt,
        'UTC',
      );
      const hourMetadata = warehouseEnabled() ? await warehouseCrawlerHourMetadata(websiteId,window.endAt-14*DAY,window.endAt) : await tx.query(
        `SELECT date_trunc('hour',l.created_at) AS hour,
        count(distinct coalesce(e.classification_version,'legacy'))::int AS classes,min(e.classification_version) AS classification,
        count(*) FILTER(WHERE e.classification_version IS NULL)::int AS legacy,
        count(distinct coalesce(l.source_id::text,'manual'))::int AS sources,min(l.source_id::text) AS source
        ${crawlerBase} GROUP BY 1`,
        websiteId,
        new Date(window.endAt - 14 * DAY),
        new Date(window.endAt),
      );
      const [pending] = await tx.query(
        "SELECT count(*)::int AS count FROM liekan_ingest_batch WHERE website_id=$1::uuid AND state='pending'",
        websiteId,
      );
      const qualityIntervals = await tx.query(
        `SELECT source_id,lower(span) AS starts_at,upper(span) AS ends_at,state,classification,source_version FROM (SELECT source_id,state,evidence->>'classificationVersion' AS classification,evidence->>'sourceVersion' AS source_version,unnest(range_agg(tstzrange(starts_at,ends_at,'[]'))) AS span FROM liekan_crawler_quality WHERE website_id=$1::uuid AND starts_at<$3 AND ends_at>$2 GROUP BY source_id,state,evidence->>'classificationVersion',evidence->>'sourceVersion') merged`,
        websiteId,
        new Date(window.endAt - 14 * DAY),
        new Date(window.endAt),
      );
      const critical = configuration?.critical_paths || [];
      const expected = warehouseEnabled() ? await warehouseCrawlerExpected(tx,websiteId,window.endAt-DAY,window.endAt,critical) : await tx.query(
        `WITH expectations AS(
        SELECT value AS path,'exact' AS match,NULL::text AS bot_id,'allow' AS expected_access,NULL::timestamptz AS since,'critical' AS kind
          FROM jsonb_array_elements_text($4::jsonb)
        UNION SELECT selector->>'value',selector->>'match',bot_id,p.body->>'expectedAccess',p.updated_at,'policy'
          FROM liekan_crawler_policy p JOIN liekan_crawler_state state ON state.website_id=p.website_id AND state.generation=p.generation,
            jsonb_array_elements(p.body->'paths') selector,jsonb_array_elements_text(p.body->'botIds') bot_id
          WHERE p.website_id=$1::uuid
      ) SELECT e.crawler_id AS "botId",x.path,x.expected_access AS "expectedAccess",
        bool_or(x.kind='critical') AS "publicKeyPath",
        count(*) FILTER(WHERE verification IN('verified_range','verified_dns','verified_edge') AND status IN(403,429) AND NOT(coalesce(${crawlerIntentionalBlock},false)))::int AS denied,
        count(*) FILTER(WHERE ${crawlerOwnedBlock} AND (x.kind='policy' OR NOT(coalesce(${crawlerIntentionalBlock},false))))::int AS owned
        ${crawlerBase.replace('WHERE l.website_id', "JOIN expectations x ON (x.bot_id IS NULL OR x.bot_id=e.crawler_id) AND (x.since IS NULL OR l.created_at>=x.since) AND (l.path=x.path OR (x.match='prefix' AND (x.path='/' OR left(l.path,length(rtrim(x.path,'/'))+1)=rtrim(x.path,'/')||'/'))) WHERE l.website_id")}
        AND e.crawler_id IS NOT NULL GROUP BY 1,2,3 ORDER BY owned DESC,denied DESC`,
        websiteId,
        new Date(window.endAt - DAY),
        new Date(window.endAt),
        JSON.stringify(critical),
      );
      const coverageEvaluated =
        previousAnalysis?.catalog_version !== catalogVersion ||
        !previousAnalysis?.window_end ||
        Math.floor(+new Date(previousAnalysis.window_end) / DAY) !== Math.floor(window.endAt / DAY);
      const snapshot = coverageEvaluated
        ? await tx.query(
            'SELECT snapshot_at,paths FROM liekan_crawler_catalog_snapshot WHERE website_id=$1::uuid AND snapshot_at<=$2 ORDER BY snapshot_at DESC LIMIT 2',
            websiteId,
            new Date(window.endAt - 14 * DAY),
          )
        : [];
      const [catalogNow] = await tx.query(
        'SELECT paths FROM liekan_crawler_catalog_snapshot WHERE website_id=$1::uuid ORDER BY snapshot_at DESC LIMIT 1',
        websiteId,
      );
      const oldCatalog = new Set<string>(snapshot[0]?.paths ?? []);
      const commonCatalog = (catalogNow?.paths ?? []).filter((path:string) => oldCatalog.has(path));
      const coverageRows = snapshot.length
        ? warehouseEnabled() ? await warehouseCrawlerCoverage(websiteId,window.endAt-14*DAY,window.endAt,window.endAt-7*DAY,commonCatalog) : await tx.query(
            `SELECT e.crawler_id AS "botId",path,
      count(*) FILTER(WHERE created_at>=$4)::int AS current,count(*) FILTER(WHERE created_at<$4)::int AS previous
      ${crawlerBase} AND method='GET' AND status>=200 AND status<300 AND e.crawler_id IS NOT NULL GROUP BY 1,2`,
            websiteId,
            new Date(window.endAt - 14 * DAY),
            new Date(window.endAt),
            new Date(window.endAt - 7 * DAY),
          )
        : [];
      const previousQuality = snapshot.length
        ? await crawlerWindowQuality(
            tx,
            websiteId,
            window.endAt - 14 * DAY,
            window.endAt - 7 * DAY,
            'UTC',
          )
        : null;
      const currentQuality = snapshot.length
        ? await crawlerWindowQuality(tx, websiteId, window.endAt - 7 * DAY, window.endAt, 'UTC')
        : null;
      return {
        warehouse: warehouseEnabled() ? await warehouseReportMetadata(websiteId) : null,
        state: state || { epoch: 1, data_revision: 0 },
        rows,
        quality,
        critical,
        expected,
        snapshot,
        coverageRows,
        previousQuality,
        currentQuality,
        catalogNow,
        hourMetadata,
        qualityIntervals,
        previousAnalysis,
        pending,
        coverageEvaluated,
      };
    },
    { timeout: 5000, repeatableRead: true },
  );
  const qualityAt = (startAt: number): CrawlerObservationQuality => {
    const metadata = facts.hourMetadata.find(row => +new Date(row.hour) === startAt);
    const intervals = facts.qualityIntervals.filter(
      row => +new Date(row.starts_at) < startAt + HOUR && +new Date(row.ends_at) > startAt,
    );
    const declarations = intervals.filter(
      row =>
        row.state === 'complete' &&
        row.classification &&
        +new Date(row.starts_at) <= startAt &&
        +new Date(row.ends_at) >= startAt + HOUR,
    );
    const declaration = declarations.length === 1 ? declarations[0] : null;
    const complete =
      !!declaration &&
      (!metadata ||
        (metadata.classes === 1 &&
          !metadata.legacy &&
          metadata.sources === 1 &&
          metadata.source === declaration.source_id &&
          metadata.classification === declaration.classification));
    return {
      state: intervals.some(row => row.state === 'partial')
        ? 'partial'
        : facts.pending.count
          ? 'unknown'
          : complete
            ? 'complete'
            : metadata
              ? 'unknown'
              : 'missing',
      basis: 'event_time',
      classificationVersion:
        metadata?.classes === 1 && !metadata.legacy
          ? metadata.classification || ''
          : !metadata
            ? declaration?.classification || ''
            : '',
      sourceVersion: complete
        ? declaration.source_version
        : metadata?.sources === 1
          ? metadata.source || 'manual'
          : !metadata
            ? declaration?.source_version || ''
            : '',
      timezone: 'UTC',
    };
  };
  const recomputeStart = facts.previousAnalysis ? window.endAt - 2 * DAY : window.endAt - 14 * DAY;
  const windows = [
    ...new Set([
      ...facts.rows
        .filter(row => +new Date(row.hour) >= recomputeStart)
        .map(row => +new Date(row.hour)),
      window.startAt,
    ]),
  ].sort((a, b) => a - b);
  const coverageIndex = new Map(
    facts.coverageRows.map(row => [JSON.stringify([row.botId, row.path]), row]),
  );
  const coverageForBot = (botId: CrawlerHttpBotId) => {
    const previousPages = facts.snapshot[0]?.paths || [],
      currentPages = facts.catalogNow?.paths || [];
    return {
      current: facts.currentQuality
        ? {
            startAt: window.endAt - 7 * DAY,
            endAt: window.endAt,
            quality: facts.currentQuality,
            pages: currentPages.map(path => ({
              path,
              validGets: coverageIndex.get(JSON.stringify([botId, path]))?.current || 0,
            })),
          }
        : null,
      previous: facts.previousQuality
        ? {
            startAt: window.endAt - 14 * DAY,
            endAt: window.endAt - 7 * DAY,
            quality: facts.previousQuality,
            pages: previousPages.map(path => ({
              path,
              validGets: coverageIndex.get(JSON.stringify([botId, path]))?.previous || 0,
            })),
          }
        : null,
    };
  };
  const observations = [];
  for (const startAt of windows) {
    const currentWindow = { startAt, endAt: startAt + HOUR };
    const currentQuality = qualityAt(startAt);
    for (const botId of getActiveCrawlerIds()) {
      const row = facts.rows.find(row => row.botId === botId && +new Date(row.hour) === startAt);
      if (!row && startAt !== window.startAt) continue;
      const counts: CrawlerRequestCounts = row
        ? (Object.fromEntries(
            [
              'requests',
              'status1xx',
              'status2xx',
              'status3xx',
              'status304',
              'status4xx',
              'status5xx',
              'denied403429',
              'head',
              'successfulGets',
            ].map(key => [key, row[key]]),
          ) as unknown as CrawlerRequestCounts)
        : {
            requests: 0,
            status1xx: 0,
            status2xx: 0,
            status3xx: 0,
            status304: 0,
            status4xx: 0,
            status5xx: 0,
            denied403429: 0,
            head: 0,
            successfulGets: 0,
          };
      const history = facts.rows
        .filter(
          r =>
            r.botId === botId &&
            +new Date(r.hour) < startAt &&
            +new Date(r.hour) >= startAt - 14 * DAY &&
            new Date(r.hour).getUTCHours() === new Date(startAt).getUTCHours(),
        )
        .slice(-14)
        .map(r => ({
          startAt: +new Date(r.hour),
          endAt: +new Date(r.hour) + HOUR,
          requests: r.requests,
          quality: qualityAt(+new Date(r.hour)),
        }));
      let coverage: ReturnType<typeof coverageForBot> | undefined;
      if (startAt === window.startAt && facts.coverageEvaluated) coverage = coverageForBot(botId);
      observations.push({
        botId,
        counts,
        window: currentWindow,
        quality: currentQuality,
        findings: evaluateCrawlerRisks({
          botId,
          now: currentWindow.endAt + 15 * 60000,
          hour: row
            ? {
                ...currentWindow,
                counts,
                quality: currentQuality,
                intentionalDenied403429: row.intentional,
              }
            : null,
          sameHourHistory: history,
          ...(coverage ? { coverage } : {}),
          rangeMismatches: row?.mismatches || 0,
          sensitivePathRequests: row?.sensitive || 0,
          expectedPaths: (startAt === window.startAt ? facts.expected : [])
            .filter(r => r.botId === botId)
            .slice(0, 100)
            .map(r => ({
              pathGroup: r.path,
              expectedAccess: r.expectedAccess as 'allow' | 'block',
              publicKeyPath: r.publicKeyPath,
              verifiedSearchDenied: r.denied,
              ownedTerminatingBlocks: r.owned,
              startAt: window.endAt - DAY,
              endAt: window.endAt,
              quality: facts.quality,
            })),
        }),
      });
    }
  }
  const committed = await crawlerTransaction(async tx => {
    if (!(await analysisAuthorityIsCurrent(tx, authority))) return false;
    if (!(await registryVersionIsCurrent(tx, catalogVersion))) return false;
    if (workerId && !(await analysisLeaseIsCurrent(tx, workerId))) return false;
    await tx.query('SELECT website_id FROM website WHERE website_id=$1::uuid FOR SHARE', websiteId);
    const [live] = await tx.query(
      'SELECT epoch,data_revision FROM liekan_log_state WHERE website_id=$1::uuid FOR SHARE',
      websiteId,
    );
    if (
      (live?.epoch ?? 1) !== facts.state.epoch ||
      (!warehouseEnabled() && String(live?.data_revision ?? 0) !== String(facts.state.data_revision))
    )
      return false;
    if (warehouseEnabled()) {
      await tx.query('SELECT website_id FROM liekan_warehouse_site WHERE website_id=$1::uuid FOR SHARE',websiteId);
      const current = await readReportingMetadata({read:(sql,params=[])=>tx.query(sql,...params)},websiteId);
      if (!facts.warehouse || warehouseControlFingerprint(current)!==warehouseControlFingerprint(facts.warehouse)) return false;
    }
    const workflowBefore = await tx.query(
      'SELECT * FROM liekan_crawler_finding WHERE website_id=$1::uuid FOR UPDATE',
      websiteId,
    );
    const activeKeys = new Set(
      observations
        .filter(o => o.window.startAt === window.startAt)
        .flatMap(o => o.findings.map(f => f.key)),
    );
    const incoming = observations.flatMap(observation =>
      observation.findings.map(finding => ({
        ...finding,
        catalogVersion,
        lastQuality: finding.type === 'coverage' ? facts.currentQuality : observation.quality,
        ...(finding.type === 'coverage'
          ? { coverageRecoveryEnd: Math.floor(window.endAt / DAY) * DAY }
          : {}),
        window_end: new Date(finding.windowEnd).toISOString(),
      })),
    );
    const recomputedEnds = windows.map(startAt => new Date(startAt + HOUR));
    await tx.execute(
      `DELETE FROM liekan_crawler_finding_window fw WHERE website_id=$1::uuid AND window_end=ANY($2::timestamptz[])
      AND EXISTS(SELECT 1 FROM liekan_crawler_finding owned WHERE owned.website_id=fw.website_id AND owned.key=fw.key AND owned.bot_id=ANY($4::text[]))
      AND fw.facts->>'type' IN('access','origin','surge','identity','sensitive_path','observation')
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($3::jsonb) incoming WHERE incoming->>'key'=fw.key AND (incoming->>'window_end')::timestamptz=fw.window_end)`,
      websiteId,
      recomputedEnds,
      JSON.stringify(incoming),
      [...getActiveCrawlerIds()],
    );
    await tx.execute(
      `UPDATE liekan_crawler_finding f SET state=CASE WHEN state='ignored' THEN 'ignored' ELSE 'resolved' END,
      facts=facts||jsonb_build_object('status','resolved','correctedByLateData',true,'catalogVersion',$3::text),updated_at=now()
      WHERE website_id=$1::uuid AND bot_id=ANY($2::text[]) AND type IN('access','origin','surge','identity','sensitive_path','observation')
      AND NOT EXISTS(SELECT 1 FROM liekan_crawler_finding_window fw WHERE fw.website_id=f.website_id AND fw.key=f.key)`,
      websiteId,
      [...getActiveCrawlerIds()],
      catalogVersion,
    );
    await tx.execute(
      `UPDATE liekan_crawler_finding f SET facts=latest.facts,grade=latest.facts->>'grade',confidence=latest.facts->>'confidence' FROM (
      SELECT DISTINCT ON(key) key,facts FROM liekan_crawler_finding_window WHERE website_id=$1::uuid ORDER BY key,window_end DESC
      ) latest WHERE f.website_id=$1::uuid AND f.bot_id=ANY($2::text[]) AND f.key=latest.key AND f.type IN('access','origin','surge','identity','sensitive_path','observation')
      AND NOT EXISTS(SELECT 1 FROM liekan_crawler_finding_window fw WHERE fw.website_id=f.website_id AND fw.key=f.key AND fw.window_end=(f.facts->>'windowEnd')::bigint*interval '1 millisecond'+timestamptz 'epoch')`,
      websiteId,
      [...getActiveCrawlerIds()],
    );
    const changed = await tx.query(
      `WITH incoming AS(SELECT f FROM jsonb_array_elements($2::jsonb) AS j(f)),
      fresh AS(INSERT INTO liekan_crawler_finding_window(website_id,key,window_end,facts)
        SELECT $1::uuid,f->>'key',(f->>'window_end')::timestamptz,f FROM incoming
        ON CONFLICT(website_id,key,window_end) DO UPDATE SET facts=EXCLUDED.facts WHERE liekan_crawler_finding_window.facts IS DISTINCT FROM EXCLUDED.facts
        RETURNING key,window_end,facts),
      picked AS(SELECT DISTINCT ON(key) key,window_end,facts FROM fresh ORDER BY key,window_end DESC)
      INSERT INTO liekan_crawler_finding(website_id,key,bot_id,type,path_group,grade,confidence,facts,window_end)
        SELECT $1::uuid,key,facts->>'botId',facts->>'type',facts->>'pathGroup',facts->>'grade',facts->>'confidence',facts,window_end FROM picked
        ON CONFLICT(website_id,key) DO UPDATE SET facts=CASE WHEN EXCLUDED.window_end>=liekan_crawler_finding.window_end THEN EXCLUDED.facts ELSE liekan_crawler_finding.facts END,grade=CASE WHEN EXCLUDED.window_end>=liekan_crawler_finding.window_end THEN EXCLUDED.grade ELSE liekan_crawler_finding.grade END,confidence=CASE WHEN EXCLUDED.window_end>=liekan_crawler_finding.window_end THEN EXCLUDED.confidence ELSE liekan_crawler_finding.confidence END,
          state=CASE WHEN liekan_crawler_finding.state='ignored' THEN 'ignored' WHEN EXCLUDED.window_end<liekan_crawler_finding.window_end THEN liekan_crawler_finding.state ELSE 'active' END,last_seen_at=now(),window_end=GREATEST(liekan_crawler_finding.window_end,EXCLUDED.window_end),good_windows=CASE WHEN EXCLUDED.window_end>=liekan_crawler_finding.window_end THEN 0 ELSE liekan_crawler_finding.good_windows END,updated_at=now()
        RETURNING key`,
      websiteId,
      JSON.stringify(incoming),
    );
    const changedKeys = new Set(changed.map(row => row.key));
    const previous = await tx.query(
      'SELECT * FROM liekan_crawler_finding WHERE website_id=$1::uuid AND bot_id=ANY($2::text[]) FOR UPDATE',
      websiteId,
      [...getActiveCrawlerIds()],
    );
    for (const old of previous) {
      if (old.type === 'coverage' && !facts.coverageEvaluated) continue;
      if (
        activeKeys.has(old.key) ||
        changedKeys.has(old.key) ||
        old.state === 'ignored' ||
        old.facts?.correctedByLateData
      )
        continue;
      if (old.type === 'coverage') {
        const recovery = coverageRecovery(
          {
            good: old.good_windows,
            dayEnd:
              old.facts?.coverageRecoveryEnd ?? Math.floor(+new Date(old.window_end) / DAY) * DAY,
            quality: old.facts?.lastQuality ?? null,
          },
          facts.currentQuality,
          Math.floor(window.endAt / DAY) * DAY,
        );
        await tx.execute(
          'UPDATE liekan_crawler_finding SET state=$3,good_windows=$4,window_end=$5,facts=facts||$6::jsonb,updated_at=now() WHERE website_id=$1::uuid AND key=$2',
          websiteId,
          old.key,
          recovery.resolved ? 'resolved' : 'active',
          recovery.good,
          new Date(window.endAt),
          JSON.stringify({
            status: recovery.resolved ? 'resolved' : 'pending',
            catalogVersion,
            lastQuality: recovery.quality,
            coverageRecoveryEnd: recovery.dayEnd,
          }),
        );
        continue;
      }
      const hasData =
        observations.find(o => o.botId === old.bot_id && o.window.startAt === window.startAt)
          ?.counts.requests > 0;
      const transition = transitionRisk(
        {
          status: old.state === 'resolved' ? 'resolved' : 'active',
          goodCompleteWindows: old.good_windows,
          lastWindowEnd: +new Date(old.window_end),
          lastQuality: old.facts?.lastQuality ?? null,
        },
        {
          outcome: hasData ? 'good' : 'no_data',
          quality: facts.quality,
          windowStart: window.startAt,
          windowEnd: window.endAt,
        },
      );
      await tx.execute(
        'UPDATE liekan_crawler_finding SET state=$3,good_windows=$4,window_end=$5,facts=facts || $6::jsonb,updated_at=now() WHERE website_id=$1::uuid AND key=$2',
        websiteId,
        old.key,
        transition.status === 'resolved' ? 'resolved' : 'active',
        transition.goodCompleteWindows,
        new Date(transition.lastWindowEnd),
        JSON.stringify({
          status: transition.status,
          lastQuality: transition.lastQuality,
          catalogVersion,
        }),
      );
    }
    await reconcileFindingWorkflow(
      tx,
      websiteId,
      workflowBefore,
      new Set(incoming.map(row => row.key)),
      facts.state.epoch,
    );
    await tx.execute(
      `INSERT INTO liekan_crawler_analysis_state(website_id,epoch,data_revision,computed_at,window_end,quality) VALUES($1::uuid,$2,$3,now(),$4,$5::jsonb)
      ON CONFLICT(website_id) DO UPDATE SET epoch=EXCLUDED.epoch,data_revision=EXCLUDED.data_revision,computed_at=now(),window_end=EXCLUDED.window_end,quality=EXCLUDED.quality,error_code=NULL`,
      websiteId,
      facts.state.epoch,
      facts.state.data_revision,
      new Date(window.endAt),
      JSON.stringify({ ...facts.quality, catalogVersion, ...(facts.warehouse ? {warehouse:facts.warehouse.boundary,warehouseControl:warehouseControlFingerprint(facts.warehouse)} : {}) }),
    );
    if (workerId && !(await analysisLeaseIsCurrent(tx, workerId)))
      throw new Error('Crawler analysis lease expired before commit');
    return true;
  });
  if (committed) analyticsCache.invalidate(websiteCacheTag(websiteId));
}
export async function processCrawlerAnalysis(workerId = randomUUID()) {
  return withinWarehouseAuthority(() =>
    withPublishedRegistry(async catalog =>
      processCrawlerAnalysisSnapshot(workerId, catalog.version, await readAnalysisAuthority()),
    ),
  );
}
async function processCrawlerAnalysisSnapshot(
  workerId: string,
  catalogVersion: string,
  authority?: AnalysisAuthority,
) {
  const candidate = await crawlerTransaction(async tx => {
    if (!(await acquireCrawlerLease(tx, 'analysis', workerId, 30))) return null;
    if (!(await acquireCrawlerLease(tx, 'analysis-rate', randomUUID(), 1.2))) {
      await releaseCrawlerLease(tx, 'analysis', workerId);
      return null;
    }
    const [row] = await tx.query(
      `SELECT s.website_id,s.epoch,s.data_revision FROM liekan_log_state s JOIN website w ON w.website_id=s.website_id AND w.deleted_at IS NULL
      LEFT JOIN liekan_crawler_analysis_state a ON a.website_id=s.website_id
      LEFT JOIN liekan_crawler_state c ON c.website_id=s.website_id
      WHERE (s.updated_at>now()-interval '24 hours' OR s.data_revision!=coalesce(a.data_revision,-1) OR jsonb_array_length(coalesce(c.critical_paths,'[]'::jsonb))>0 OR a.quality->>'catalogVersion' IS DISTINCT FROM $1)
        AND (a.computed_at IS NULL OR a.computed_at<now()-interval '10 minutes' OR a.quality->>'catalogVersion' IS DISTINCT FROM $1)
        AND NOT EXISTS(SELECT 1 FROM liekan_crawler_lease cooldown WHERE cooldown.name='analysis-failure:'||s.website_id::text AND cooldown.expires_at>now())
      ORDER BY a.computed_at NULLS FIRST,s.website_id LIMIT 1`,
      catalogVersion,
    );
    if (!row) await releaseCrawlerLease(tx, 'analysis', workerId);
    return row || null;
  });
  if (!candidate) return;
  let renewal: Promise<unknown> | undefined;
  const heartbeat = warehouseEnabled() ? setInterval(() => {
    if (renewal) return;
    renewal = crawlerTransaction(tx => tx.execute("UPDATE liekan_crawler_lease SET expires_at=clock_timestamp()+interval '30 seconds' WHERE name='analysis' AND owner=$1::uuid AND expires_at>clock_timestamp()",workerId))
      .catch(()=>undefined).finally(()=>{renewal=undefined;});
  },10000) : undefined;
  try {
    await recomputeCrawlerRisksSnapshot(
      candidate.website_id,
      Date.now(),
      catalogVersion,
      workerId,
      authority,
    );
  } catch {
    await crawlerTransaction(async tx => {
      if (!(await analysisAuthorityIsCurrent(tx, authority))) return;
      if (!(await registryVersionIsCurrent(tx, catalogVersion))) return;
      if (!(await analysisLeaseIsCurrent(tx, workerId))) return;
      const [live] = await tx.query(
        'SELECT epoch,data_revision FROM liekan_log_state WHERE website_id=$1::uuid FOR SHARE',
        candidate.website_id,
      );
      if (
        live?.epoch !== candidate.epoch ||
        String(live?.data_revision) !== String(candidate.data_revision)
      )
        return;
      await acquireCrawlerLease(tx, `analysis-failure:${candidate.website_id}`, workerId, 600);
      return tx.execute(
        `INSERT INTO liekan_crawler_analysis_state(website_id,epoch,data_revision,computed_at,window_end,quality,error_code) VALUES($1::uuid,1,0,now(),now(),'{}','analysis-unavailable')
      ON CONFLICT(website_id) DO UPDATE SET error_code='analysis-unavailable'`,
        candidate.website_id,
      );
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await renewal;
    await crawlerTransaction(tx => releaseCrawlerLease(tx, 'analysis', workerId));
  }
}

function warehouseCrawlerRead<T>(work:(tx:AiTx)=>Promise<T>,_options?:unknown) {
  return withinWarehouseReport(() => warehouseControlRead(work,{stable:(sql,values)=>{
    const rows=values as Record<string,unknown>[];
    if (/SELECT epoch,data_revision FROM liekan_log_state\b/.test(sql)) return rows.map(({data_revision:_data,...row})=>row);
    if (/FROM liekan_ingest_batch\b/.test(sql)) return rows.map(row=>({...row,count:Number(row.count)>0}));
    return rows;
  }}));
}
