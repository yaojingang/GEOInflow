import { registryVersionIsCurrent } from './crawler-registry';
import { warehouseEnabled } from '../warehouse/runtime';
import { warehouseControlRead } from './warehouse-control-read';
import { warehouseReportQuery, withinWarehouseReport } from './warehouse-report-snapshot';
import { effectiveLogRelation } from '../warehouse/reporting-relations';
import { warehouseTime } from '../warehouse/fact-input';
import { getPublishedCatalog } from '../crawlers/published';
import { randomUUID } from 'node:crypto';
import { ROLES, SHARE_CONTEXT_HEADER, SHARE_TOKEN_HEADER } from '@/lib/constants';
import { aiTransaction, type AiTx } from './ai-db';
import {
  authenticateCrawler,
  authorizeCrawler,
  crawlerTransaction,
  type CrawlerActor,
} from './crawler-access';
import { LiekanError } from './errors';
import {
  acquireCrawlerSourceLease,
  CrawlerSourceBusyError,
  crawlerSourceLeaseOwned,
  releaseCrawlerSourceLease,
  rangeSourceHealth,
  type CrawlerSourceLease,
} from './crawler-ranges';
import {
  getDocumentSources,
  getDocumentJobSeconds,
  type DocumentSource,
} from '../crawlers/document-sources';
import {
  checkDocumentSource,
  documentCheckErrorCode,
  qualifiedDocumentHash,
  type DocumentObservation,
  type DocumentCheckResult,
} from '../crawlers/document-check';
import {
  rangeSourceHealthSchema,
  type CrawlerSourcesResponse,
  type DocumentSourceHealth,
  type CrawlerRecognitionResponse,
  type CrawlerCandidatesResponse,
} from '../contracts/crawler-maintenance';
import { CRAWLER_REGISTRY_VERSION, getCrawlerRegistry } from '../crawlers/registry';
import { resolveCrawlerRules } from '../rules/configuration';
import { crawlerIdForRule } from '../crawlers/directory';
import { crawlerClassificationVersion } from '../log-ingestion/crawler-evidence';
import { unknownCrawlerSql } from '../rules/population';
import { summarizeUnknownSample } from '../crawlers/unknown-tokens';

const DAY = 86400000;
const iso = (value: unknown): string | null =>
  value == null || !Number.isFinite(+new Date(value as string))
    ? null
    : new Date(value as string).toISOString();
type Row = Record<string, any>;
type DocumentLease = {
  source: DocumentSource;
  token: string;
  epoch: string;
  previous?: DocumentObservation;
};

export async function authenticateCrawlerMaintenance(request: Request) {
  // Reject even stale or invalid public-context headers alongside an otherwise valid session.
  if (request.headers.has(SHARE_CONTEXT_HEADER) || request.headers.has(SHARE_TOKEN_HEADER))
    throw new LiekanError('请使用完整登录会话查看蜘蛛维护信息', 401);
  return authenticateCrawler(request);
}
async function authorizeAdmin(tx: AiTx, actor: CrawlerActor) {
  const [live] = await tx.query(
    'SELECT role FROM "user" WHERE user_id=$1::uuid AND deleted_at IS NULL FOR SHARE',
    actor.id,
  );
  if (!live) throw new LiekanError('当前登录已失效', 401);
  if (live.role !== ROLES.admin) throw new LiekanError('此操作需要平台管理员权限', 403);
}

/** A later reviewed release may acknowledge only observations made by its manual review date. */
export async function initializeDocumentSources() {
  await aiTransaction(
    async tx => {
      const version = getPublishedCatalog()?.version;
      if (version && !(await registryVersionIsCurrent(tx, version))) return;
      for (const source of getDocumentSources()) {
        await tx.execute(
          `INSERT INTO liekan_crawler_document_source(source_id,source_url,reviewed_at)
        VALUES($1,$2,$3::date) ON CONFLICT DO NOTHING`,
          source.id,
          source.url,
          source.reviewedAt,
        );
        await tx.execute(
          `UPDATE liekan_crawler_document_source SET reviewed_at=$3::date,
        baseline_hash=CASE WHEN last_success_at < $3::date+interval '1 day' THEN current_hash ELSE baseline_hash END,
        pending_review=CASE WHEN last_success_at < $3::date+interval '1 day' THEN false ELSE pending_review END,
        lease_epoch=lease_epoch+1,lease_token=NULL,lease_until=NULL
        WHERE source_id=$1 AND source_url=$2 AND reviewed_at<$3::date AND $3::date<=CURRENT_DATE`,
          source.id,
          source.url,
          source.reviewedAt,
        );
      }
    },
    { timeout: 15000 },
  );
}
async function claimDocument(
  source: DocumentSource,
  globalToken: string,
  globalEpoch: string,
  force: boolean,
  sharedLease: CrawlerSourceLease,
): Promise<DocumentLease | null> {
  return aiTransaction(async tx => {
    const version = getPublishedCatalog()?.version;
    if (version && !(await registryVersionIsCurrent(tx, version))) return null;
    if (!(await crawlerSourceLeaseOwned(tx, sharedLease, 30, true))) return null;
    const token = randomUUID();
    const [state] = await tx.query(
      `UPDATE liekan_crawler_document_source SET
      lease_token=$2::uuid,lease_epoch=lease_epoch+1,lease_until=clock_timestamp()+interval '60 seconds',last_attempt_at=clock_timestamp()
      WHERE source_id=$1 AND source_url=$3 AND (lease_until IS NULL OR lease_until<=clock_timestamp())
      AND ($4 OR next_check_at<=clock_timestamp()) AND EXISTS (
        SELECT 1 FROM liekan_crawler_document_lease WHERE id='documents' AND token=$5::uuid AND epoch=$6::bigint
        AND lease_until>clock_timestamp()+interval '30 seconds') RETURNING *`,
      source.id,
      token,
      source.url,
      force,
      globalToken,
      globalEpoch,
    );
    if (!state) return null;
    return {
      source,
      token,
      epoch: String(state.lease_epoch),
      ...(qualifiedDocumentHash(state.current_hash)
        ? {
            previous: {
              hash: state.current_hash,
              etag: state.etag,
              lastModified: state.last_modified,
            },
          }
        : {}),
    };
  });
}
async function refreshDocument(
  lease: DocumentLease,
  globalToken: string,
  globalEpoch: string,
  sharedLease: CrawlerSourceLease,
  fetcher?: typeof fetch,
) {
  let result: DocumentCheckResult | undefined,
    errorCode: string | null = null;
  try {
    result = await checkDocumentSource(lease.source, lease.previous, { fetcher });
  } catch (error) {
    errorCode = documentCheckErrorCode(error);
  }
  return aiTransaction(async tx => {
    const version = getPublishedCatalog()?.version;
    if (version && !(await registryVersionIsCurrent(tx, version))) return 'superseded' as const;
    if (!(await crawlerSourceLeaseOwned(tx, sharedLease, 0, true))) return 'superseded' as const;
    const [global] = await tx.query(
      "SELECT id FROM liekan_crawler_document_lease WHERE id='documents' AND token=$1::uuid AND epoch=$2::bigint AND lease_until>clock_timestamp() FOR SHARE",
      globalToken,
      globalEpoch,
    );
    if (!global) return 'superseded' as const;
    const [state] = await tx.query(
      `SELECT s.* FROM liekan_crawler_document_source s
      WHERE s.source_id=$1 AND s.lease_token=$2::uuid AND s.lease_epoch=$3::bigint AND s.lease_until>clock_timestamp()
      AND EXISTS (SELECT 1 FROM liekan_crawler_document_lease WHERE id='documents' AND token=$4::uuid AND epoch=$5::bigint
        AND lease_until>clock_timestamp()) FOR UPDATE`,
      lease.source.id,
      lease.token,
      lease.epoch,
      globalToken,
      globalEpoch,
    );
    if (!state) return 'superseded' as const;
    await tx.execute(
      `UPDATE liekan_crawler_document_source SET
      baseline_hash=CASE WHEN $4 THEN coalesce(baseline_hash,$5) ELSE baseline_hash END,
      pending_review=pending_review OR ($4 AND current_hash IS NOT NULL AND current_hash<>$5),
      current_hash=CASE WHEN $4 THEN $5 ELSE current_hash END,
      last_success_at=CASE WHEN $4 THEN $6::timestamptz ELSE last_success_at END,
      consecutive_failures=CASE WHEN $4 THEN 0 ELSE consecutive_failures+1 END,error_code=$7,
      etag=CASE WHEN $4 THEN $8 ELSE etag END,last_modified=CASE WHEN $4 THEN $9 ELSE last_modified END,
      next_check_at=clock_timestamp()+interval '7 days',lease_token=NULL,lease_until=NULL
      WHERE source_id=$1 AND lease_token=$2::uuid AND lease_epoch=$3::bigint`,
      lease.source.id,
      lease.token,
      lease.epoch,
      Boolean(result),
      result?.hash ?? null,
      result?.observedAt ?? null,
      errorCode,
      result?.etag ?? null,
      result?.lastModified ?? null,
    );
    return result?.status ?? 'failed';
  });
}

/** One shared capacity lease keeps IP and document refreshes at two requests in total. */
export async function refreshDocumentSources(
  options: { force?: boolean; fetcher?: typeof fetch } = {},
) {
  await initializeDocumentSources();
  const sources = getDocumentSources();
  const jobSeconds = getDocumentJobSeconds();
  const sharedLease = await acquireCrawlerSourceLease(jobSeconds);
  if (!sharedLease) throw new CrawlerSourceBusyError();
  const token = randomUUID();
  let epoch: string | null = null;
  try {
    const [acquired] = await aiTransaction(async tx => {
      await tx.execute(
        "INSERT INTO liekan_crawler_document_lease(id) VALUES('documents') ON CONFLICT DO NOTHING",
      );
      return tx.query(
        `UPDATE liekan_crawler_document_lease SET token=$1::uuid,epoch=epoch+1,
        lease_until=clock_timestamp()+$2*interval '1 second' WHERE id='documents'
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING epoch`,
        token,
        jobSeconds,
      );
    });
    if (!acquired) throw new CrawlerSourceBusyError();
    epoch = String(acquired.epoch);
    const results: { id: string; status: string }[] = [];
    let cursor = 0;
    const outcomes = await Promise.allSettled(
      Array.from({ length: 2 }, async () => {
        while (cursor < sources.length) {
          const source = sources[cursor++];
          const lease = await claimDocument(
            source,
            token,
            epoch,
            options.force === true,
            sharedLease,
          );
          if (lease)
            results.push({
              id: source.id,
              status: await refreshDocument(lease, token, epoch, sharedLease, options.fetcher),
            });
        }
      }),
    );
    if (outcomes.some(outcome => outcome.status === 'rejected'))
      throw new Error('Document maintenance persistence unavailable');
    return results;
  } finally {
    // Both worker lanes have settled before either lease is released, including failed persistence.
    try {
      if (epoch)
        await aiTransaction(tx =>
          tx.execute(
            "UPDATE liekan_crawler_document_lease SET token=NULL,lease_until=NULL WHERE id='documents' AND token=$1::uuid AND epoch=$2::bigint",
            token,
            epoch,
          ),
        );
    } finally {
      await releaseCrawlerSourceLease(sharedLease);
    }
  }
}
export function documentSourceHealth(
  source: DocumentSource,
  state?: Row,
  now = Date.now(),
): DocumentSourceHealth {
  const currentHash = qualifiedDocumentHash(state?.current_hash) ? state.current_hash : null;
  const lastSuccessAt = iso(state?.last_success_at);
  return {
    id: source.id,
    url: source.url,
    label: source.label,
    names: [...source.names],
    reviewedAt: source.reviewedAt,
    currentHash,
    baselineHash: qualifiedDocumentHash(state?.baseline_hash) ? state.baseline_hash : null,
    lastAttemptAt: iso(state?.last_attempt_at),
    lastSuccessAt,
    nextCheckAt: iso(state?.next_check_at),
    consecutiveFailures: state?.consecutive_failures ?? 0,
    errorCode: state?.error_code ?? null,
    status:
      !currentHash || !lastSuccessAt
        ? state?.consecutive_failures >= 2
          ? 'warning'
          : state?.consecutive_failures > 0 || state?.error_code
            ? 'update_failed'
            : 'missing'
        : state?.pending_review
          ? 'review_required'
          : state?.consecutive_failures >= 2 ||
              now - Date.parse(lastSuccessAt) > 14 * DAY ||
              Date.parse(lastSuccessAt) > now
            ? 'warning'
            : state?.error_code
              ? 'update_failed'
              : 'healthy',
    reviewOverdue: now - Date.parse(source.reviewedAt) > 45 * DAY,
  };
}
export async function crawlerSources(actor: CrawlerActor): Promise<CrawlerSourcesResponse> {
  return crawlerTransaction(async tx => {
    await authorizeAdmin(tx, actor);
    const rows = await tx.query('SELECT * FROM liekan_crawler_document_source');
    const now = Date.now();
    const ipSources = await rangeSourceHealth(now, { initialize: false });
    return {
      catalogVersion: getPublishedCatalog()?.version || CRAWLER_REGISTRY_VERSION,
      checkedAt: new Date(now).toISOString(),
      ipSources: ipSources.map(source => rangeSourceHealthSchema.parse(source)),
      documents: getDocumentSources().map(source =>
        documentSourceHealth(
          source,
          rows.find(row => row.source_id === source.id && row.source_url === source.url),
          now,
        ),
      ),
    };
  });
}
export async function crawlerRecognition(
  actor: CrawlerActor,
  websiteId: string,
): Promise<CrawlerRecognitionResponse> {
  return crawlerTransaction(async tx => {
    await authorizeCrawler(tx, actor, websiteId);
    const [row] = await tx.query(
      'SELECT rules,crawler_rules AS "crawlerRules",rules_revision AS "rulesRevision" FROM liekan_setting WHERE website_id=$1::uuid',
      websiteId,
    );
    const { configuration, rules } = resolveCrawlerRules(row);
    return {
      mode: configuration.mode,
      classificationVersion: crawlerClassificationVersion(rules, configuration),
      rulesRevision: row?.rulesRevision ?? 0,
      enabledIds: [
        ...new Set([
          ...rules.flatMap(rule => {
            const id = crawlerIdForRule(rule);
            return id ? [id] : [];
          }),
          ...(configuration.mode === 'official'
            ? getCrawlerRegistry()
                .filter(
                  identity =>
                    identity.kind === 'signed_agent' &&
                    identity.status === 'active' &&
                    !configuration.disabledIds.includes(identity.id),
                )
                .map(identity => identity.id)
            : []),
        ]),
      ],
    };
  });
}
function queryTimedOut(error: any): boolean {
  return (
    (warehouseEnabled() && (error?.code === '159' || ['AbortError','TimeoutError'].includes(error?.name))) ||
    error?.code === '57014' ||
    error?.meta?.code === '57014' ||
    error?.cause?.code === '57014' ||
    error?.meta?.driverAdapterError?.cause?.originalCode === '57014' ||
    error?.code === 'P2028'
  );
}
export async function crawlerCandidates(
  actor: CrawlerActor,
  websiteId: string,
): Promise<CrawlerCandidatesResponse> {
  const end = new Date(),
    start = new Date(+end - 7 * DAY),
    deadline = +end + 5000;
  const base = {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    scanLimit: 100000 as const,
  };
  try {
    const rows = warehouseEnabled() ? await withinWarehouseReport(() => warehouseControlRead(async tx => {
      await authorizeCrawler(tx,actor,websiteId);
      const rows=await warehouseReportQuery<{userAgent:string;createdAt:string}>(websiteId,`SELECT l.user_agent AS userAgent,toString(l.created_at) AS createdAt
        FROM ${effectiveLogRelation({immutableTimeWindow:{start:'candidateStart',end:'candidateEnd',endExclusive:true}})} l
        WHERE ${unknownCrawlerSql('l')} AND l.user_agent NOT LIKE 'Liekan-Crawler-Check/%' ORDER BY l.created_at DESC,l.id DESC LIMIT 100000`,
        {candidateStart:warehouseTime(start),candidateEnd:warehouseTime(end)}, {timeoutSeconds:5,signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
      return rows.map(row=>({...row,createdAt:new Date(row.createdAt.replace(' ','T')+'Z')}));
    },{deadline})) : await crawlerTransaction(
      async tx => {
        await authorizeCrawler(tx, actor, websiteId);
        return tx.query<{ userAgent: string; createdAt: Date }>(
          `SELECT l.user_agent AS "userAgent",l.created_at AS "createdAt"
        FROM liekan_effective_log l WHERE l.website_id=$1::uuid AND l.created_at>=$2::timestamptz AND l.created_at<$3::timestamptz
        AND ${unknownCrawlerSql('l')} AND l.user_agent NOT LIKE 'Liekan-Crawler-Check/%'
        ORDER BY l.created_at DESC,l.id DESC LIMIT 100000`,
          websiteId,
          start,
          end,
        );
      },
      { timeout: 5000, transactionTimeout: 6000 },
    );
    const sample = summarizeUnknownSample(rows, { deadline });
    // Aggregation runs outside permission locks, then the private response rechecks current access.
    await crawlerTransaction(tx => authorizeCrawler(tx, actor, websiteId));
    return {
      ...base,
      state: 'ready' as const,
      scannedRows: sample.scannedRows,
      partial: sample.partial || rows.length === 100000,
      scannedStart: sample.scannedRows ? iso(rows[sample.scannedRows - 1].createdAt) : null,
      scannedEnd: sample.scannedRows ? iso(rows[0].createdAt) : null,
      items: sample.items,
    };
  } catch (error) {
    if (!queryTimedOut(error)) throw error;
    // A cancelled transaction no longer holds permission locks; authorize the unavailable response anew.
    await crawlerTransaction(tx => authorizeCrawler(tx, actor, websiteId));
    return {
      ...base,
      state: 'unavailable',
      scannedRows: 0,
      partial: true,
      scannedStart: null,
      scannedEnd: null,
      items: [],
    };
  }
}
