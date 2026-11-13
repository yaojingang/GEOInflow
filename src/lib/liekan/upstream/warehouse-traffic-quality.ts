import { createHash } from 'node:crypto';
import type { TrafficPolicy } from '../contracts/traffic-quality';
import { getPublishedCatalog } from '../crawlers/published';
import { diagnosticCoverage } from '../traffic-quality/diagnostics';
import { normalizeCollectionHostname } from '../traffic-quality/hostname';
import { warehouseTime } from '../warehouse/fact-input';
import { factRelation } from '../warehouse/read';
import { qualityAuditRelation, qualityIncludedPredicate } from '../warehouse/reporting-relations';
import { LiekanError, lockWritableWebsite, transaction, type WriteIdentity } from './server';
import { trafficGovernanceState } from './traffic-exclusions';
import {
  getTrafficPolicy,
  type parseQualityRange,
  qualityReadTransaction,
} from './traffic-quality';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';
import {
  warehouseReportMetadata,
  warehouseReportQuery,
  withinWarehouseReport,
} from './warehouse-report-snapshot';

type Range = ReturnType<typeof parseQualityRange>;
const count = (v: unknown) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('warehouse-counter-out-of-range');
  return n;
};
const scope = `({auditClassification:Nullable(String)} IS NULL OR coalesce(classification,'unknown')={auditClassification:Nullable(String)})
  AND ({auditSource:Nullable(String)} IS NULL OR source={auditSource:Nullable(String)})
  AND ({auditHost:Nullable(String)} IS NULL OR hostname={auditHost:Nullable(String)} OR normalized_hostname={auditHost:Nullable(String)})
  AND ({auditPath:Nullable(String)} IS NULL OR url_path={auditPath:Nullable(String)})`;
const parameters = (range: Range) => ({
  auditStart: warehouseTime(new Date(range.startAt)),
  auditEnd: warehouseTime(new Date(range.endAt)),
  auditClassification: range.classification ?? null,
  auditSource: range.source ?? null,
  auditHost: range.hostname ?? null,
  auditPath: range.path ?? null,
});
const relation = (preview = false) =>
  `(SELECT *,${qualityIncludedPredicate(preview ? 'previewMode' : undefined, preview ? 'previewHosts' : undefined)} AS included FROM ${qualityAuditRelation()} WHERE ${scope})`;
export async function warehouseQualityTotals(site: string, range: Range, proposed?: TrafficPolicy) {
  const [r] = await warehouseReportQuery<any>(
    site,
    `SELECT count() AS rawPV,countIf(included) AS includedPV,
    if(countIf(NOT identity_available)=0,uniqExact(session_id),NULL) AS rawUV,
    if(countIf(included AND NOT identity_available)=0,uniqExactIf(session_id,included),NULL) AS includedUV,
    uniqExactIf(session_id,included AND identity_available) AS qualifiedUV,countIf(included AND identity_available) AS qualifiedPV,
    countIf(isNull(verdict_id)) AS missingVerdictPV FROM ${relation(!!proposed)} WHERE event_type=1`,
    {
      ...parameters(range),
      previewMode: proposed?.mode ?? 'standard',
      previewHosts: proposed?.allowedHostnames ?? [],
    },
  );
  for (const key of Object.keys(r)) if (r[key] !== null) r[key] = count(r[key]);
  return {
    ...r,
    excludedPV: r.rawPV - r.includedPV,
    fullyExcludedUV: r.rawUV === null || r.includedUV === null ? null : r.rawUV - r.includedUV,
    identityCoverage: r.includedPV ? r.qualifiedPV / r.includedPV : null,
  };
}
async function governanceCounts(site: string, state: any) {
  if (!state.collections.length) return state;
  // Only bounded control IDs travel to CH. Event membership never leaves CH.
  const rows = await warehouseReportQuery<{ collection_id: string; events: string }>(
    site,
    `SELECT collection_id,count() AS events FROM ${factRelation('liekan_traffic_exclusion_member')}
     WHERE collection_id IN {collections:Array(UUID)} GROUP BY collection_id`,
    { collections: state.collections.map((x: any) => x.id) },
  );
  const counts = new Map(rows.map(r => [r.collection_id, count(r.events)]));
  return {
    ...state,
    collections: state.collections.map((x: any) => ({ ...x, events: counts.get(x.id) ?? 0 })),
  };
}
export async function warehouseTrafficGovernanceState(site: string, cursor?: string) {
  return withinWarehouseReport(async () => {
    await warehouseReportMetadata(site);
    const state = await qualityReadTransaction(tx => trafficGovernanceState(tx, site, cursor));
    return governanceCounts(site, state);
  });
}
export async function warehousePreviewTrafficPolicy(
  site: string,
  proposed: TrafficPolicy,
  range: Range,
  identity: WriteIdentity,
) {
  return withinWarehouseReport(async () => {
    await warehouseReportMetadata(site);
    const policy = await transaction(async tx => {
      await lockWritableWebsite(tx, site, identity, 'share');
      const current = await getTrafficPolicy(site, tx);
      if (proposed.expectedRevision !== undefined && proposed.expectedRevision !== current.revision)
        throw new LiekanError('统计策略已更新，请刷新后重新预览', 409);
      return current;
    });
    const current = await warehouseQualityTotals(site, range),
      preview = await warehouseQualityTotals(site, range, proposed);
    // Slow CH work holds no PostgreSQL transaction or permission lock.
    await transaction(tx => lockWritableWebsite(tx, site, identity, 'share'));
    return {
      policy,
      proposed,
      range: { startAt: range.startAt, endAt: range.endAt, timezone: range.timezone },
      current,
      preview,
    };
  });
}
export async function warehouseTrafficQualityAudit(site: string, range: Range) {
  return withinWarehouseReport(async () => {
    const metadata = await warehouseReportMetadata(site);
    const {
      policy,
      governance: controlGovernance,
      domain,
      state,
      history,
    } = await qualityReadTransaction(async tx => {
      const policy = await getTrafficPolicy(site, tx),
        governance = await trafficGovernanceState(tx, site);
      const [website] = await tx.$queryRawUnsafe(
        'SELECT domain FROM website WHERE website_id=$1::uuid',
        site,
      );
      const [state] = await tx.$queryRawUnsafe(
        'SELECT (SELECT started_at FROM liekan_collection_diagnostic_state WHERE website_id=$1::uuid) AS started_at,clock_timestamp() AS read_at',
        site,
      );
      const history = await tx.$queryRawUnsafe(
        'SELECT id::text,actor_id::text AS "actorId",created_at AS "createdAt",before_policy AS before,after_policy AS after FROM liekan_collection_policy_history WHERE website_id=$1::uuid ORDER BY id DESC LIMIT 20',
        site,
      );
      return { policy, governance, domain: website?.domain, state, history };
    });
    const params = parameters(range);
    const signature = createHash('sha256')
      .update(
        JSON.stringify([
          site,
          params,
          metadata.boundary.epoch,
          metadata.boundary.deletionRevision,
          metadata.repairGeneration,
          metadata.controlRevision,
          policy.revision,
          controlGovernance.revision,
          controlGovernance.epoch,
          TRAFFIC_POLICY_VERSION,
          getPublishedCatalog()?.version,
        ]),
      )
      .digest('hex');
    let cursor: { time: string; id: string; signature: string } | undefined;
    if (range.cursor) {
      try {
        if (range.cursor.length > 1024) throw new Error();
        cursor = JSON.parse(Buffer.from(range.cursor, 'base64url').toString());
      } catch {
        throw new LiekanError('分页游标无效');
      }
      if (
        !cursor ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(cursor.time) ||
        !Number.isFinite(Date.parse(cursor.time)) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)
      )
        throw new LiekanError('分页游标无效');
      if (cursor.signature !== signature)
        throw new LiekanError('审计条件或策略已变化，请从第一页读取', 409);
    }
    const query = <T = any>(sql: string, extra: Record<string, unknown> = {}) =>
      warehouseReportQuery<T>(site, sql, { ...params, ...extra });
    const hosts = (
      await query(`SELECT coalesce(normalized_hostname,hostname) AS hostname,count() AS events,countIf(event_type=1) AS pageviews
      FROM ${relation()} GROUP BY hostname ORDER BY events DESC,hostname NULLS LAST LIMIT 100`)
    ).map(r => ({ ...r, events: count(r.events), pageviews: count(r.pageviews) }));
    const summary = (
      await query(`SELECT coalesce(classification,'unknown') AS classification,count() AS events,
      if(countIf(event_type=1 AND NOT identity_available)=0,uniqExactIf(session_id,event_type=1),NULL) AS visitors,
      countIf(event_type=1) AS pageviews,countIf(event_type=1 AND audit.included) AS included_pageviews,
      countIf(isNull(verdict_id)) AS missing_verdict,countIf(audit.included) AS included FROM ${relation()} audit GROUP BY classification ORDER BY classification`)
    ).map(r =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, k === 'classification' || v === null ? v : count(v)]),
      ),
    );
    const rows = await query(
      `SELECT event_id AS eventId,formatDateTime(created_at,'%Y-%m-%dT%H:%i:%S.%fZ','UTC') AS cursorTime,
      url_path AS path,hostname,normalized_hostname AS normalizedHostname,coalesce(classification,'unknown') AS classification,
      source,coalesce(reasons,[]) AS reasons,rule_version AS ruleVersion,range_status AS rangeStatus,range_version AS rangeVersion,
      included,current_classification AS currentClassification FROM ${relation()}
      WHERE ({cursorTime:Nullable(DateTime64(6,'UTC'))} IS NULL OR (created_at,event_id)<({cursorTime:Nullable(DateTime64(6,'UTC'))},{cursorId:UUID}))
      ORDER BY created_at DESC,event_id DESC LIMIT 101 OFFSET {auditOffset:UInt64}`,
      {
        cursorTime: cursor?.time ? warehouseTime(cursor.time) : null,
        cursorId: cursor?.id ?? '00000000-0000-0000-0000-000000000000',
        auditOffset: cursor ? 0 : (range.page - 1) * 100,
      },
    );
    const partition = (
      await query(`SELECT multiIf(included,'included',isNull(source),'source_unknown',source<>'browser','nonbrowser_source',
      current_classification='automated','known_automation',has(current_reasons,'bot_check_disabled'),'unverified_collection',
      {wh_policy_mode:String}='strict' AND current_classification='suspected','strict_policy',
      NOT empty({wh_allowed_hosts:Array(String)}) AND (isNull(policy_hostname) OR NOT has({wh_allowed_hosts:Array(String)},policy_hostname)
        OR (isNotNull(origin_hostname) AND NOT has({wh_allowed_hosts:Array(String)},origin_hostname))),'hostname_conflict',
      excluded,'confirmed_exclusion',current_classification<>'browser','unclassified_browser',
      isNull(identity_scope) OR identity_scope<>'browser' OR NOT identity_available,'identity_unavailable','unknown_evidence') AS bucket,
      count() AS pageviews FROM ${relation()} WHERE event_type=1 GROUP BY bucket ORDER BY bucket`)
    ).map(r => ({ ...r, pageviews: count(r.pageviews) }));
    const bucketStartAt = Math.floor(range.startAt / 60000) * 60000,
      bucketEndAt = Math.floor(range.endAt / 60000) * 60000 + 60000;
    const coverage = diagnosticCoverage(
      bucketStartAt,
      bucketEndAt,
      state.started_at ? +state.started_at : null,
      +state.read_at,
    );
    const [rawDiagnostic] = await query(
      `SELECT sum(written) AS written,sum(with_uuid) AS withUuid,sum(duplicate) AS duplicate
      FROM ${factRelation('liekan_collection_diagnostic')} WHERE bucket>={bucketStart:DateTime64(6,'UTC')} AND bucket<{bucketEnd:DateTime64(6,'UTC')}`,
      {
        bucketStart: warehouseTime(
          new Date(Math.max(bucketStartAt, Date.parse(coverage.retainedFrom))),
        ),
        bucketEnd: warehouseTime(new Date(bucketEndAt)),
      },
    );
    const diagnostic = {
      written: count(rawDiagnostic.written),
      withUuid: count(rawDiagnostic.withUuid),
      duplicate: count(rawDiagnostic.duplicate),
    };
    const last = rows[99],
      nextCursor =
        rows.length > 100
          ? Buffer.from(
              JSON.stringify({ time: last.cursorTime, id: last.eventId, signature }),
            ).toString('base64url')
          : null;
    return {
      available: true,
      classificationBasis: 'collection-original',
      reportingBasis: 'current-policy-and-active-history-repair',
      policy,
      governance: await governanceCounts(site, controlGovernance),
      range: { startAt: range.startAt, endAt: range.endAt, timezone: range.timezone },
      totals: await warehouseQualityTotals(site, range),
      domainAudit: { expectedHostname: normalizeCollectionHostname(domain), hosts },
      summary,
      partition,
      rows: rows
        .slice(0, 100)
        .map(({ cursorTime, included, ...r }) => ({
          ...r,
          createdAt: new Date(cursorTime),
          included: !!included,
        })),
      page: range.page,
      pageSize: 100,
      nextCursor,
      history,
      diagnostics: {
        ...diagnostic,
        ...coverage,
        written: coverage.coverage === 'missing' ? null : diagnostic.written,
        withUuid: coverage.coverage === 'missing' ? null : diagnostic.withUuid,
        duplicate: coverage.coverage === 'missing' ? null : diagnostic.duplicate,
        startedAt: state.started_at || null,
        bucketStartAt,
        bucketEndAt,
        duplicateFraction:
          coverage.coverage !== 'missing' && diagnostic.written + diagnostic.duplicate
            ? diagnostic.duplicate / (diagnostic.written + diagnostic.duplicate)
            : null,
        uuidCoverage:
          coverage.coverage !== 'missing' && diagnostic.written
            ? diagnostic.withUuid / diagnostic.written
            : null,
      },
    };
  });
}
