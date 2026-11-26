import { createHash } from 'node:crypto';
import { CRAWLER_METRIC_VERSION, evidenceValue } from '../contracts/crawler-metrics';
import type { ReconciliationQuery } from '../contracts/traffic-evidence';
import type { CrawlerActor } from '../upstream/crawler-access';
import { OBSERVATION_VERSION } from '../upstream/collection-observation';
import { normalizeCollectionHostname } from '../upstream/collection-quality';
import { LiekanError } from '../upstream/errors';
import { TRAFFIC_POLICY_VERSION } from '../upstream/traffic-query';
import {
  queryV2Observations,
  queryV2Reconciliation,
  readV2CatalogCached,
  readV2ControlContext,
  verifyV2WebsiteAccess,
} from './diagnostics';
import { warehouseV2Runtime } from './runtime';

const sha256 = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function queryV2EvidenceFast(
  actor: CrawlerActor,
  websiteId: string,
  params: Record<string, any>,
  kind: 'observations' | 'traffic-quality/reconciliation',
  signal?: AbortSignal,
) {
  const rt = warehouseV2Runtime();
  await rt.ensureReady();

  const actorId =
    actor && typeof actor === 'object' && typeof actor.id === 'string' && actor.id.trim()
      ? actor.id.trim()
      : null;
  if (!actorId) {
    throw new LiekanError('请先登录', 401);
  }

  // Single lock-free query on dedicated v2 PG pool enforces website/team authorization
  // and loads control metadata without contending on Prisma interactive transactions.
  const control = await readV2ControlContext(rt.pg, websiteId, actorId);
  if (!control) {
    throw new LiekanError('网站不存在或无权访问', 404);
  }

  const page = Math.max(1, Number(params.page ?? 1));
  const pageSize = 20;

  if (kind === 'observations') {
    const startAt = Math.max(Number(params.startAt), Date.now() - 30 * 86_400_000);
    const endAt = Number(params.endAt);
    const subset = params.subset === 'eligible' ? 'eligible' : 'raw';

    const obs = await queryV2Observations(rt.ch, control, {
      startAt,
      endAt,
      subset,
      observationVersion: OBSERVATION_VERSION,
      page,
      pageSize,
      abortSignal: signal,
    });

    const reset = Boolean(params.snapshot && params.snapshot !== obs.fingerprint);
    const effectivePage = reset ? 1 : page;
    const rows =
      reset && page !== 1
        ? (
            await queryV2Observations(rt.ch, control, {
              startAt,
              endAt,
              subset,
              observationVersion: OBSERVATION_VERSION,
              page: 1,
              pageSize,
              abortSignal: signal,
            })
          ).rows
        : obs.rows;

    const pv = obs.totals.pv;
    const idPv = obs.totals.identityQualifiedPv;
    const observationIdentity = {
      version: 'received-browser-identity-v1' as const,
      timeBasis: 'received_at' as const,
      population: subset === 'raw' ? ('raw_public_pv' as const) : ('eligible_public_pv' as const),
      range: { startAt, endAt, timezone: params.timezone, endExclusive: true as const },
      status: !pv
        ? ('empty' as const)
        : idPv === pv
          ? ('complete' as const)
          : idPv
            ? ('partial' as const)
            : ('unavailable' as const),
      totalPV: pv,
      qualifiedPV: idPv,
      qualifiedVisitors: obs.totals.identityQualifiedVisitors,
      coverage: pv ? idPv / pv : null,
      versions: obs.totals.identityVersions,
      versionsTruncated: false,
    };

    const coverage = Object.fromEntries(
      Object.entries(obs.coverage).map(([field, item]) => [
        field,
        evidenceValue(
          item.value,
          item.samples,
          item.total,
          item.state as 'available' | 'partial' | 'unknown',
          pv ? null : 'no_received_pv',
          'received_at',
        ),
      ]),
    );

    const policySnapshot = sha256({
      epoch: control.epoch,
      policyMode: control.policyMode,
      policyRevision: control.policyRevision,
      populationVersion: TRAFFIC_POLICY_VERSION,
      metricVersion: CRAWLER_METRIC_VERSION,
    });

    const {
      identityQualifiedPv: _iqp,
      identityQualifiedVisitors: _iqv,
      identityVersions: _iv,
      ...totalsOut
    } = obs.totals;

    // Re-verify website/team access before returning data (guards against mid-read removal).
    if (!(await verifyV2WebsiteAccess(rt.pg, websiteId, actorId, control))) {
      throw new LiekanError('网站不存在或无权访问', 404);
    }

    return {
      meta: {
        metricVersion: CRAWLER_METRIC_VERSION,
        conditions: { ...params, page: 1, snapshot: undefined },
        population: subset === 'raw' ? 'raw_public_pv' : 'eligible_public_pv',
        timeBasis: 'received_at',
        timeBoundary: 'half_open',
        readAt: new Date().toISOString(),
        dataThrough: obs.lastReceivedAt,
        policy: {
          mode: control.policyMode,
          revision: control.policyRevision,
          allowed_hostnames: control.allowedHostnames,
        },
        policySnapshot,
        epoch: Number(control.epoch),
        observationVersion: OBSERVATION_VERSION,
        observationIdentity,
        observationState: obs.lastReceivedAt
          ? {
              epoch: Number(control.epoch),
              lastReceivedAt: obs.lastReceivedAt,
              lastVersion: OBSERVATION_VERSION,
            }
          : null,
        historicalReception: 'unknown',
        snapshot: obs.fingerprint,
        page: effectivePage,
        pageSize,
        total: obs.totalGroups,
        reset,
      },
      rows,
      totals: totalsOut,
      coverage,
      state: !pv ? 'unknown' : obs.totals.currentVersion !== pv ? 'partial' : 'available',
      reasonCode: !pv
        ? 'no_received_pv'
        : obs.totals.currentVersion !== pv
          ? 'observation_missing_or_mixed'
          : null,
    };
  }

  // traffic-quality/reconciliation
  const p = params as ReconciliationQuery;
  if (p.sourceId && p.sourceId !== 'manual' && !control.sources.some(s => s.id === p.sourceId)) {
    throw new LiekanError('日志来源不存在', 404);
  }
  const hostname = normalizeCollectionHostname(p.hostname);
  const sourceHost =
    p.sourceId === 'manual'
      ? control.domain
      : control.sources.find(s => s.id === p.sourceId)?.domain;
  if (!hostname || hostname !== normalizeCollectionHostname(sourceHost)) {
    throw new LiekanError('对账主机不属于所选来源', 400);
  }

  const catalog = await readV2CatalogCached(rt.pg, websiteId, control.catalogVersion);
  const rec = await queryV2Reconciliation(rt.ch, control, catalog, {
    startAt: p.startAt,
    endAt: p.endAt,
    hostname,
    sourceId: p.sourceId,
    path: p.path,
    page,
    pageSize,
    sort: p.sort,
    direction: p.direction,
    abortSignal: signal,
  });

  const reset = Boolean(p.snapshot && p.snapshot !== rec.fingerprint);
  const effectivePage = reset ? 1 : page;
  const pageRows =
    reset && page !== 1
      ? (
          await queryV2Reconciliation(rt.ch, control, catalog, {
            startAt: p.startAt,
            endAt: p.endAt,
            hostname,
            sourceId: p.sourceId,
            path: p.path,
            page: 1,
            pageSize,
            sort: p.sort,
            direction: p.direction,
            abortSignal: signal,
          })
        ).rows
      : rec.rows;

  const formattedRows = pageRows.map(row => ({
    humanPath: row.humanPath,
    encodedPaths: row.encodedPaths,
    collisionPaths: row.encodedPaths,
    ambiguous: row.ambiguous,
    requests: row.requests,
    get2xx: row.get2xx,
    crawler: row.crawler,
    candidate: row.candidate,
    ambiguousRequests: row.ambiguousRequests,
    confirmedHtml: row.confirmedHtml,
    contentType: evidenceValue(
      row.requests ? row.contentTypeSamples / row.requests : null,
      row.contentTypeSamples,
      row.requests,
      row.contentTypeSamples === row.requests && row.requests > 0
        ? 'available'
        : row.contentTypeSamples
          ? 'partial'
          : 'missing',
    ),
    observedPv: row.observedPv,
    unknownHostPv: row.unknownHostPv,
    pv: row.pv,
    uv: row.uv,
    visits: row.visits,
    difference: evidenceValue(
      row.difference,
      row.hostSamples,
      row.requests,
      row.reason ? 'not_comparable' : 'available',
      row.reason,
    ),
  }));

  const policySnapshot = sha256({
    catalog: catalog.hash,
    epoch: control.epoch,
    policyMode: control.policyMode,
    policyRevision: control.policyRevision,
    populationVersion: TRAFFIC_POLICY_VERSION,
    metricVersion: CRAWLER_METRIC_VERSION,
  });

  // Re-verify website/team access before returning data (guards against mid-read removal).
  if (!(await verifyV2WebsiteAccess(rt.pg, websiteId, actorId, control))) {
    throw new LiekanError('网站不存在或无权访问', 404);
  }

  return {
    meta: {
      metricVersion: CRAWLER_METRIC_VERSION,
      conditions: { ...p, page: 1, snapshot: undefined },
      population: 'catalog_page_requests',
      hostname,
      timeBasis: 'event_time',
      timeBoundary: 'half_open',
      readAt: new Date().toISOString(),
      logDataThrough: rec.logLastAt,
      browserDataThrough: rec.browserLastAt,
      catalogBaseline: catalog.hash,
      policySnapshot,
      policy: {
        mode: control.policyMode,
        revision: control.policyRevision,
        allowed_hostnames: control.allowedHostnames,
      },
      epoch: Number(control.epoch),
      sources: control.sources,
      snapshot: rec.fingerprint,
      page: effectivePage,
      pageSize,
      total: rec.totalRows,
      reset,
    },
    rows: formattedRows,
    browserTotals: rec.browserTotals,
    state: rec.totalRows ? 'available' : 'missing',
    reasonCode: rec.totalRows ? null : 'catalog_missing',
    rawRequests: rec.rawRequests,
  };
}
