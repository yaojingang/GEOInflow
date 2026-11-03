import { warehouseEnabled } from '@/lib/liekan/warehouse/authority-routing';
import { createHash } from 'node:crypto';
import {
  qualityRangeSchema,
  type TrafficPolicy,
  trafficPolicySchema,
  trafficPreviewSchema,
} from '../contracts/traffic-quality';
import { getPublishedCatalog } from '../crawlers/published';
import { diagnosticCoverage } from '../traffic-quality/diagnostics';
import { bumpAnalyticsRevision } from './analytics-revision';
import { COLLECTION_RULE_VERSION, normalizeCollectionHostname } from './collection-quality';
import { invalidateWebsiteAnalytics } from './query-cache';
import { LiekanError, lockWritableWebsite, transaction, type WriteIdentity } from './server';
import { trafficGovernanceState } from './traffic-exclusions';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';

export function requireQualitySupport() {
  if (process.env.CLICKHOUSE_URL) throw new LiekanError('流量质量分析当前支持 PostgreSQL', 501);
}
export async function getTrafficPolicy(websiteId: string, tx?: any) {
  const load = async (client: any) => {
    const [row] = await client.$queryRawUnsafe(
      'SELECT mode,allowed_hostnames,revision::text FROM liekan_collection_policy WHERE website_id=$1::uuid',
      websiteId,
    );
    return {
      mode: row?.mode || 'standard',
      effectiveMode: row?.mode === 'strict' ? 'strict' : 'standard',
      rawAuditOnly: row?.mode === 'raw',
      allowedHostnames: row?.allowed_hostnames || [],
      revision: row?.revision || '0',
      ruleVersion: COLLECTION_RULE_VERSION,
      populationVersion: TRAFFIC_POLICY_VERSION,
    };
  };
  return tx ? load(tx) : transaction(load);
}
export function normalizeTrafficPolicy(input: unknown): TrafficPolicy {
  const parsed = trafficPolicySchema.safeParse(input);
  if (!parsed.success) throw new LiekanError('流量统计设置无效');
  return {
    ...parsed.data,
    allowedHostnames: [
      ...new Set(
        parsed.data.allowedHostnames.map(value => {
          if (/[\s/@?#*]/.test(value)) throw new LiekanError('允许域名须填写完整主机名');
          const host = normalizeCollectionHostname(value);
          if (!host) throw new LiekanError('允许域名无效');
          return host;
        }),
      ),
    ].sort(),
  };
}
async function hostRepresentations(tx: any, websiteId: string) {
  const reported = await tx.$queryRawUnsafe(
    'SELECT DISTINCT hostname FROM website_event WHERE website_id=$1::uuid AND hostname IS NOT NULL LIMIT 10001',
    websiteId,
  );
  if (reported.length > 10000)
    throw new LiekanError('历史主机名超过 10,000 种，请先核对域名审计', 413);
  return reported.map((row: any) => ({
    reported: row.hostname,
    hostname: normalizeCollectionHostname(row.hostname),
  }));
}
export async function saveTrafficPolicy(
  websiteId: string,
  input: unknown,
  identity: WriteIdentity,
) {
  requireQualitySupport();
  const proposed = normalizeTrafficPolicy(input);
  const result = await transaction(async tx => {
    await lockWritableWebsite(tx, websiteId, identity);
    const before = await getTrafficPolicy(websiteId, tx);
    if (proposed.expectedRevision !== undefined && proposed.expectedRevision !== before.revision)
      throw new LiekanError('统计策略已更新，请刷新后重新预览', 409);
    if (proposed.allowedHostnames.length && process.env.LIEKAN_ANALYTICS_BACKEND !== 'clickhouse') {
      for (const row of await hostRepresentations(tx, websiteId)) {
        await tx.$executeRawUnsafe(
          `INSERT INTO liekan_collection_hostname(website_id,reported_hash,hostname) VALUES($1::uuid,$2,$3)
          ON CONFLICT(website_id,reported_hash) DO UPDATE SET hostname=EXCLUDED.hostname`,
          websiteId,
          createHash('sha256').update(row.reported).digest('hex'),
          row.hostname,
        );
      }
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO liekan_collection_policy(website_id,mode,allowed_hostnames) VALUES($1::uuid,$2,$3::text[])
       ON CONFLICT(website_id) DO UPDATE SET mode=EXCLUDED.mode,allowed_hostnames=EXCLUDED.allowed_hostnames,revision=liekan_collection_policy.revision+1,updated_at=now()`,
      websiteId,
      proposed.mode,
      proposed.allowedHostnames,
    );
    const after = await getTrafficPolicy(websiteId, tx);
    if (warehouseEnabled())
      await tx.$executeRawUnsafe(
        'UPDATE liekan_warehouse_site SET policy_revision=$2::bigint,updated_at=clock_timestamp() WHERE website_id=$1::uuid',
        websiteId,
        after.revision,
      );
    await tx.$executeRawUnsafe(
      'INSERT INTO liekan_collection_policy_history(website_id,actor_id,before_policy,after_policy) VALUES($1::uuid,$2::uuid,$3::jsonb,$4::jsonb)',
      websiteId,
      identity.userId,
      JSON.stringify(before),
      JSON.stringify(after),
    );
    await bumpAnalyticsRevision(tx, 'website', websiteId);
    return after;
  });
  invalidateWebsiteAnalytics(websiteId);
  return result;
}
export function parseQualityRange(parameters: URLSearchParams) {
  const parsed = qualityRangeSchema.safeParse(Object.fromEntries(parameters));
  if (!parsed.success) throw new LiekanError('质量审计范围无效');
  const endAt = parsed.data.endAt ?? Date.now(),
    startAt = parsed.data.startAt ?? endAt - 86400000;
  if (
    ![startAt, endAt].every(Number.isSafeInteger) ||
    startAt < 0 ||
    endAt > 8640000000000000 ||
    endAt < startAt ||
    endAt - startAt > 366 * 86400000
  )
    throw new LiekanError('质量审计范围无效');
  const timezone = parsed.data.timezone || 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new LiekanError('时区无效');
  }
  return { ...parsed.data, startAt, endAt, timezone, page: parsed.data.page ?? 1 };
}
type Range = ReturnType<typeof parseQualityRange>;
export function qualityReadTransaction<T>(work: (tx: any) => Promise<T>): Promise<T> {
  return transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    // Fresh imports can severely underestimate site cardinality. Nested loops and
    // site-only merge joins can repeatedly scan the same quality rows. Prefer hash
    // joins for this read; both preferences end with the transaction.
    await tx.$executeRawUnsafe('SET LOCAL enable_nestloop = off');
    await tx.$executeRawUnsafe('SET LOCAL enable_mergejoin = off');
    return work(tx);
  });
}
const scope = `e.website_id=$1::uuid AND e.created_at BETWEEN $2 AND $3
 AND ($4::text IS NULL OR COALESCE(q.classification,'unknown')=$4)
 AND ($5::text IS NULL OR q.source=$5) AND ($6::text IS NULL OR e.hostname=$6 OR q.hostname=$6)
 AND ($7::text IS NULL OR e.url_path=$7)`;
const evidenceJoins = `FROM website_event e LEFT JOIN liekan_event_quality q ON q.event_id=e.event_id AND q.website_id=e.website_id LEFT JOIN liekan_event_environment identity_env ON identity_env.event_id=e.event_id AND identity_env.website_id=e.website_id`;
const joins = `${evidenceJoins}
 LEFT JOIN liekan_effective_website_event effective ON effective.event_id=e.event_id AND effective.website_id=e.website_id
 AND effective.created_at BETWEEN $2 AND $3`;
const bindings = (id: string, range: Range) => [
  id,
  new Date(range.startAt),
  new Date(range.endAt),
  range.classification || null,
  range.source || null,
  range.hostname || null,
  range.path || null,
];
export async function qualityTotals(
  tx: any,
  websiteId: string,
  range: Range,
  proposed?: TrafficPolicy,
) {
  const params = bindings(websiteId, range);
  let included = 'effective.event_id IS NOT NULL',
    extra = '';
  if (proposed) {
    // The preview reads normalized historical hosts without changing saved policy or evidence.
    const hosts = proposed.allowedHostnames.length ? await hostRepresentations(tx, websiteId) : [];
    params.push(proposed.mode, proposed.allowedHostnames as any, JSON.stringify(hosts));
    extra = `LEFT JOIN liekan_reporting_event_quality candidate ON candidate.event_id=e.event_id AND candidate.website_id=e.website_id
      LEFT JOIN jsonb_to_recordset($10::jsonb) AS h(reported text,hostname text) ON h.reported=e.hostname
      LEFT JOIN liekan_event_environment env ON env.event_id=e.event_id AND env.website_id=e.website_id`;
    included = `(candidate.source='browser' AND e.event_type IN(1,2,5)
      AND candidate.classification='browser' AND env.scope='browser' AND env.identity_available
      AND NOT('bot_check_disabled'=ANY(candidate.reasons))
      AND ($8<>'strict' OR candidate.classification<>'suspected')
      AND (cardinality($9::text[])=0 OR (COALESCE(candidate.hostname,h.hostname)=ANY($9::text[])
        AND (env.origin_hostname IS NULL OR env.origin_hostname=ANY($9::text[]))))
      AND NOT EXISTS(SELECT 1 FROM liekan_traffic_exclusion_member m JOIN liekan_traffic_exclusion x
        ON x.id=m.collection_id AND x.website_id=m.website_id LEFT JOIN liekan_log_state ls ON ls.website_id=x.website_id
        WHERE m.website_id=e.website_id AND m.event_id=e.event_id AND x.state='active' AND x.epoch=coalesce(ls.epoch,1)))`;
  }
  const [result] = await tx.$queryRawUnsafe(
    `SELECT COUNT(*)::float8 AS "rawPV",COUNT(*) FILTER(WHERE ${included})::float8 AS "includedPV",
      CASE WHEN COUNT(*) FILTER(WHERE NOT COALESCE(identity_env.identity_available,false))=0 THEN COUNT(DISTINCT e.session_id)::float8 ELSE NULL END AS "rawUV",
      CASE WHEN COUNT(*) FILTER(WHERE ${included} AND NOT COALESCE(identity_env.identity_available,false))=0 THEN COUNT(DISTINCT e.session_id) FILTER(WHERE ${included})::float8 ELSE NULL END AS "includedUV",
      COUNT(DISTINCT e.session_id) FILTER(WHERE ${included} AND identity_env.identity_available)::float8 AS "qualifiedUV",
      COUNT(*) FILTER(WHERE ${included} AND identity_env.identity_available)::float8 AS "qualifiedPV",
      COUNT(*) FILTER(WHERE q.event_id IS NULL)::float8 AS "missingVerdictPV"
      ${proposed ? evidenceJoins : joins} ${extra} WHERE ${scope} AND e.event_type=1`,
    ...params,
  );
  return {
    ...result,
    excludedPV: result.rawPV - result.includedPV,
    fullyExcludedUV:
      result.rawUV === null || result.includedUV === null ? null : result.rawUV - result.includedUV,
    identityCoverage: result.includedPV ? result.qualifiedPV / result.includedPV : null,
  };
}
export async function previewTrafficPolicy(
  websiteId: string,
  input: unknown,
  identity: WriteIdentity,
) {
  requireQualitySupport();
  const parsed = trafficPreviewSchema.safeParse(input);
  if (!parsed.success) throw new LiekanError('预览参数无效');
  const proposed = normalizeTrafficPolicy(parsed.data.policy);
  const range = parseQualityRange(
    new URLSearchParams(Object.entries(parsed.data.range).map(([k, v]) => [k, String(v)])),
  );
  if (warehouseEnabled())
    return (await import('./warehouse-traffic-quality')).warehousePreviewTrafficPolicy(
      websiteId,
      proposed,
      range,
      identity,
    );
  return qualityReadTransaction(async tx => {
    await lockWritableWebsite(tx, websiteId, identity, 'share');
    const policy = await getTrafficPolicy(websiteId, tx);
    if (proposed.expectedRevision !== undefined && proposed.expectedRevision !== policy.revision)
      throw new LiekanError('统计策略已更新，请刷新后重新预览', 409);
    return {
      policy,
      proposed,
      range: { startAt: range.startAt, endAt: range.endAt, timezone: range.timezone },
      current: await qualityTotals(tx, websiteId, range),
      preview: await qualityTotals(tx, websiteId, range, proposed),
    };
  });
}
/** Each manual read uses one snapshot; cursor scope includes the policy revision. */
export async function trafficQualityAudit(websiteId: string, parameters: URLSearchParams) {
  if (process.env.CLICKHOUSE_URL)
    return { available: false, reason: '流量质量分析当前支持 PostgreSQL' };
  const range = parseQualityRange(parameters);
  if (warehouseEnabled())
    return (await import('./warehouse-traffic-quality')).warehouseTrafficQualityAudit(
      websiteId,
      range,
    );
  return qualityReadTransaction(async tx => {
    const policy = await getTrafficPolicy(websiteId, tx);
    const values = bindings(websiteId, range);
    const [repair] = await tx.$queryRawUnsafe(
      "SELECT active_generation::text,active_revision::text FROM liekan_history_repair_run WHERE website_id=$1::uuid AND campaign_id='traffic-quality-repair-20261022-v1'",
      websiteId,
    );
    const governance = await trafficGovernanceState(tx, websiteId);
    const signature = createHash('sha256')
      .update(
        JSON.stringify([
          values,
          repair?.active_generation || null,
          repair?.active_revision || '0',
          policy.revision,
          governance.revision,
          governance.epoch,
          TRAFFIC_POLICY_VERSION,
          getPublishedCatalog()?.version,
        ]),
      )
      .digest('hex');
    let cursor: { time: string; id: string; signature: string } | undefined;
    if (range.cursor) {
      try {
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
    const [website] = await tx.$queryRawUnsafe(
      'SELECT domain FROM website WHERE website_id=$1::uuid',
      websiteId,
    );
    const hosts = await tx.$queryRawUnsafe(
      `SELECT COALESCE(q.hostname,e.hostname) AS hostname,COUNT(*)::float8 AS events,COUNT(*) FILTER(WHERE e.event_type=1)::float8 AS pageviews ${evidenceJoins} WHERE ${scope} GROUP BY 1 ORDER BY events DESC,hostname NULLS LAST LIMIT 100`,
      ...values,
    );
    const summary = await tx.$queryRawUnsafe(
      `SELECT COALESCE(q.classification,'unknown') AS classification,COUNT(*)::float8 AS events,
       CASE WHEN COUNT(*) FILTER(WHERE e.event_type=1 AND NOT COALESCE(identity_env.identity_available,false))=0 THEN COUNT(DISTINCT e.session_id) FILTER(WHERE e.event_type=1)::float8 ELSE NULL END AS visitors,COUNT(*) FILTER(WHERE e.event_type=1)::float8 AS pageviews,
       COUNT(*) FILTER(WHERE e.event_type=1 AND effective.event_id IS NOT NULL)::float8 AS included_pageviews,
       COUNT(*) FILTER(WHERE q.event_id IS NULL)::float8 AS missing_verdict,COUNT(*) FILTER(WHERE effective.event_id IS NOT NULL)::float8 AS included
       ${joins} WHERE ${scope} GROUP BY 1 ORDER BY 1`,
      ...values,
    );
    const rows = await tx.$queryRawUnsafe(
      `SELECT e.event_id::text AS "eventId",e.created_at AS "createdAt",to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime",
       e.url_path AS path,e.hostname,q.hostname AS "normalizedHostname",COALESCE(q.classification,'unknown') AS classification,q.source,COALESCE(q.reasons,'{}') AS reasons,
       q.rule_version AS "ruleVersion",q.range_status AS "rangeStatus",q.range_version AS "rangeVersion",(effective.event_id IS NOT NULL) AS included,
       (SELECT current.classification FROM liekan_reporting_event_quality current WHERE current.event_id=e.event_id AND current.website_id=e.website_id) AS "currentClassification"
       ${joins} WHERE ${scope} AND ($8::timestamptz IS NULL OR (e.created_at,e.event_id)<($8::timestamptz,$9::uuid))
       ORDER BY e.created_at DESC,e.event_id DESC LIMIT 101 OFFSET $10`,
      ...values,
      cursor?.time || null,
      cursor?.id || null,
      cursor ? 0 : (range.page - 1) * 100,
    );
    const partition = await tx.$queryRawUnsafe(
      `SELECT bucket,count(*)::int AS pageviews FROM (
      SELECT CASE
        WHEN effective.event_id IS NOT NULL THEN 'included'
        WHEN q.source IS NULL THEN 'source_unknown'
        WHEN q.source<>'browser' THEN 'nonbrowser_source'
        WHEN current.classification='automated' THEN 'known_automation'
        WHEN 'bot_check_disabled'=ANY(current.reasons) THEN 'unverified_collection'
        WHEN p.mode='strict' AND current.classification='suspected' THEN 'strict_policy'
        WHEN coalesce(cardinality(p.allowed_hostnames),0)>0 AND
          (coalesce(current.hostname,h.hostname) IS NULL OR NOT(coalesce(current.hostname,h.hostname)=ANY(p.allowed_hostnames))
           OR (env.origin_hostname IS NOT NULL AND NOT(env.origin_hostname=ANY(p.allowed_hostnames)))) THEN 'hostname_conflict'
        WHEN EXISTS(SELECT 1 FROM liekan_traffic_exclusion_member m JOIN liekan_traffic_exclusion x
          ON x.id=m.collection_id AND x.website_id=m.website_id LEFT JOIN liekan_log_state ls ON ls.website_id=x.website_id
          WHERE m.website_id=e.website_id AND m.event_id=e.event_id AND x.state='active' AND x.epoch=coalesce(ls.epoch,1)) THEN 'confirmed_exclusion'
        WHEN current.classification<>'browser' THEN 'unclassified_browser'
        WHEN env.event_id IS NULL OR env.scope<>'browser' OR NOT env.identity_available THEN 'identity_unavailable'
        ELSE 'unknown_evidence' END AS bucket
      ${joins}
      LEFT JOIN liekan_reporting_event_quality current ON current.event_id=e.event_id AND current.website_id=e.website_id
      LEFT JOIN liekan_event_environment env ON env.event_id=e.event_id AND env.website_id=e.website_id
      LEFT JOIN liekan_collection_policy p ON p.website_id=e.website_id
      LEFT JOIN liekan_collection_hostname h ON h.website_id=e.website_id AND current.hostname IS NULL
        AND h.reported_hash=encode(sha256(convert_to(e.hostname,'UTF8')),'hex')
      WHERE ${scope} AND e.event_type=1
    ) partition GROUP BY bucket ORDER BY bucket`,
      ...values,
    );
    const last = rows[99];
    const nextCursor =
      rows.length > 100
        ? Buffer.from(
            JSON.stringify({ time: last.cursorTime, id: last.eventId, signature }),
          ).toString('base64url')
        : null;
    const bucketStartAt = Math.floor(range.startAt / 60000) * 60000,
      bucketEndAt = Math.floor(range.endAt / 60000) * 60000 + 60000;
    const [state] = await tx.$queryRawUnsafe(
      'SELECT (SELECT started_at FROM liekan_collection_diagnostic_state WHERE website_id=$1::uuid) AS started_at,clock_timestamp() AS read_at',
      websiteId,
    );
    const coverage = diagnosticCoverage(
      bucketStartAt,
      bucketEndAt,
      state?.started_at ? +state.started_at : null,
      +state.read_at,
    );
    const [diagnostic] = await tx.$queryRawUnsafe(
      `SELECT COALESCE(SUM(written),0)::float8 AS written,COALESCE(SUM(with_uuid),0)::float8 AS "withUuid",COALESCE(SUM(duplicate),0)::float8 AS duplicate
       FROM liekan_collection_diagnostic WHERE website_id=$1::uuid AND bucket >= $2 AND bucket < $3`,
      websiteId,
      new Date(Math.max(bucketStartAt, Date.parse(coverage.retainedFrom))),
      new Date(bucketEndAt),
    );
    const history = await tx.$queryRawUnsafe(
      'SELECT id::text,actor_id::text AS "actorId",created_at AS "createdAt",before_policy AS before,after_policy AS after FROM liekan_collection_policy_history WHERE website_id=$1::uuid ORDER BY id DESC LIMIT 20',
      websiteId,
    );
    return {
      available: true,
      classificationBasis: 'collection-original',
      reportingBasis: 'current-policy-and-active-history-repair',
      policy,
      governance,
      range: { startAt: range.startAt, endAt: range.endAt, timezone: range.timezone },
      totals: await qualityTotals(tx, websiteId, range),
      domainAudit: { expectedHostname: normalizeCollectionHostname(website?.domain), hosts },
      summary,
      partition,
      rows: rows.slice(0, 100).map(({ cursorTime, ...row }: any) => row),
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
        startedAt: state?.started_at || null,
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
