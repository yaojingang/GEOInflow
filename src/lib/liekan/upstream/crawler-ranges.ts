import { registryVersionIsCurrent } from './crawler-registry';
import { getPublishedCatalog } from '../crawlers/published';
import { randomUUID } from 'node:crypto';
import { query } from './server';
import { aiTransaction, type AiTx } from './ai-db';
import { getRangeSources, type RangeSource } from '../crawlers/range-sources';
import {
  checkRangeSource,
  isQualifiedRangeContent,
  getRangeBaselines,
  rangeCheckErrorCode,
  type RangeContent,
} from '../crawlers/range-check';
import { legacyBundledVerificationSnapshots, type VerificationSnapshots } from '../rules/verify';
import legacy from '../../../../config/liekan/bot-ranges.json';

export const RANGE_REFRESH_MS = 3600000;
export const RANGE_LEASE_MS = 60000;
const DAY = 86400000;
type Row = Record<string, any>;
type Lease = {
  source: RangeSource;
  token: string;
  epoch: string;
  previous?: {
    content: RangeContent;
    observedAt: string;
    etag: string | null;
    lastModified: string | null;
  };
};
const iso = (value: unknown): string | null =>
  value == null
    ? null
    : Number.isFinite(+new Date(value as string))
      ? new Date(value as string).toISOString()
      : null;

function contentFromRow(row: Row): RangeContent {
  return {
    version: row.version,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    parserVersion: row.parser_version,
    names: row.names,
    crawlerIds: row.crawler_ids,
    prefixes: Object.freeze(row.prefixes) as string[],
    publishedAt: iso(row.published_at),
  };
}
async function archive(tx: AiTx, content: RangeContent, observedAt: string) {
  await tx.execute(
    `INSERT INTO liekan_crawler_range_snapshot(source_id,version,source_url,parser_version,names,crawler_ids,prefixes,address_families,published_at,observed_at)
     VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::timestamptz,$10::timestamptz) ON CONFLICT(source_id,version) DO NOTHING`,
    content.sourceId,
    content.version,
    content.sourceUrl,
    content.parserVersion,
    JSON.stringify(content.names),
    JSON.stringify(content.crawlerIds),
    JSON.stringify(content.prefixes),
    JSON.stringify([
      ...new Set(content.prefixes.map(prefix => (prefix.includes(':') ? 'ipv6' : 'ipv4'))),
    ]),
    content.publishedAt,
    observedAt,
  );
}
async function observe(tx: AiTx, content: RangeContent, observedAt: string) {
  await tx.execute(
    'INSERT INTO liekan_crawler_range_observation(source_id,version,observed_at) VALUES($1,$2,$3::timestamptz) ON CONFLICT DO NOTHING',
    content.sourceId,
    content.version,
    observedAt,
  );
}
async function mirror(tx: AiTx, content: RangeContent, observedAt: string) {
  // The phase-B compatibility candidate reads this table during a coordinated rollback.
  for (const name of content.names)
    await tx.execute(
      `INSERT INTO liekan_bot_snapshot(bot,source_url,prefixes,retrieved_at,version) VALUES($1,$2,$3::jsonb,$4::timestamptz,$5)
     ON CONFLICT(bot) DO UPDATE SET source_url=EXCLUDED.source_url,prefixes=EXCLUDED.prefixes,retrieved_at=EXCLUDED.retrieved_at,version=EXCLUDED.version,error_code=NULL`,
      name,
      content.sourceUrl,
      JSON.stringify(content.prefixes),
      observedAt,
      content.version,
    );
}

/** A reviewed release baseline can activate a candidate; an older binary cannot rewind it. */
export async function initializeRangeSources() {
  await aiTransaction(
    async tx => {
      const version = getPublishedCatalog()?.version;
      if (version && !(await registryVersionIsCurrent(tx, version))) return;
      for (const [name, snapshot] of Object.entries(legacyBundledVerificationSnapshots)) {
        await archive(
          tx,
          {
            sourceId: `legacy-bundled:${name}`,
            version: snapshot.version!,
            sourceUrl: legacy[name].source,
            parserVersion: 'bundled-v1',
            names: [name],
            crawlerIds: [],
            prefixes: snapshot.prefixes,
            publishedAt: legacy[name].publishedAt,
          },
          snapshot.retrievedAt,
        );
      }
      for (const source of getRangeSources()) {
        await tx.execute(
          'INSERT INTO liekan_crawler_range_source(source_id) VALUES($1) ON CONFLICT DO NOTHING',
          source.id,
        );
        const baseline = getRangeBaselines()[source.id];
        if (
          !baseline ||
          !isQualifiedRangeContent(source, baseline.content) ||
          !iso(baseline.observedAt) ||
          +new Date(baseline.observedAt) > Date.now()
        )
          continue;
        await archive(tx, baseline.content, baseline.observedAt);
        await observe(tx, baseline.content, baseline.observedAt);
        await tx.execute(
          'INSERT INTO liekan_crawler_range_source(source_id) VALUES($1) ON CONFLICT DO NOTHING',
          source.id,
        );
        const [state] = await tx.query(
          'SELECT * FROM liekan_crawler_range_source WHERE source_id=$1 FOR UPDATE',
          source.id,
        );
        if (
          state.baseline_version === baseline.content.version &&
          state.baseline_observed_at &&
          +state.baseline_observed_at >= +new Date(baseline.observedAt)
        )
          continue;
        const [current] = state.current_version
          ? await tx.query(
              'SELECT * FROM liekan_crawler_range_snapshot WHERE source_id=$1 AND version=$2',
              source.id,
              state.current_version,
            )
          : [];
        const activate =
          !state.current_version ||
          !state.last_success_at ||
          +state.last_success_at <= +new Date(baseline.observedAt) ||
          !current ||
          !isQualifiedRangeContent(source, contentFromRow(current));
        await tx.execute(
          `UPDATE liekan_crawler_range_source SET baseline_version=$2,baseline_observed_at=$3::timestamptz,
        current_version=CASE WHEN $4 THEN $2 ELSE current_version END,current_observed_at=CASE WHEN $4 THEN $3::timestamptz ELSE current_observed_at END,
        last_success_at=CASE WHEN $4 THEN $3::timestamptz ELSE last_success_at END,candidate_version=CASE WHEN $4 THEN NULL ELSE candidate_version END,
        error_code=CASE WHEN $4 THEN NULL ELSE error_code END,consecutive_failures=CASE WHEN $4 THEN 0 ELSE consecutive_failures END,
        etag=CASE WHEN $4 THEN NULL ELSE etag END,last_modified=CASE WHEN $4 THEN NULL ELSE last_modified END,
        lease_epoch=lease_epoch+1,lease_token=NULL,lease_until=NULL WHERE source_id=$1`,
          source.id,
          baseline.content.version,
          baseline.observedAt,
          activate,
        );
        if (activate) await mirror(tx, baseline.content, baseline.observedAt);
      }
    },
    { timeout: 15000 },
  );
}
const initializations = new Map<string, Promise<void>>();
function initialize() {
  const version = getPublishedCatalog()?.version || 'bundled';
  let initialized = initializations.get(version);
  if (!initialized) {
    initialized = initializeRangeSources().catch(error => {
      initializations.delete(version);
      throw error;
    });
    initializations.set(version, initialized);
    while (initializations.size > 8) initializations.delete(initializations.keys().next().value!);
  }
  return initialized;
}

export class CrawlerSourceBusyError extends Error {
  readonly code = 'crawler_source_maintenance_busy';
  constructor() {
    super('crawler_source_maintenance_busy');
    this.name = 'CrawlerSourceBusyError';
  }
}

export type CrawlerSourceLease = { token: string; epoch: string };

/** IP and documentation refreshes share this durable network-capacity lease. */
export async function acquireCrawlerSourceLease(seconds = 300): Promise<CrawlerSourceLease | null> {
  const token = randomUUID();
  const [state] = await aiTransaction(async tx => {
    await tx.execute(
      "INSERT INTO liekan_crawler_range_source(source_id) VALUES('__refresh__') ON CONFLICT DO NOTHING",
    );
    return tx.query(
      `UPDATE liekan_crawler_range_source SET lease_token=$1::uuid,
      lease_until=clock_timestamp()+$2*interval '1 second',lease_epoch=lease_epoch+1
      WHERE source_id='__refresh__' AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING lease_epoch`,
      token,
      seconds,
    );
  });
  return state ? { token, epoch: String(state.lease_epoch) } : null;
}
export async function crawlerSourceLeaseOwned(
  tx: AiTx,
  lease: CrawlerSourceLease,
  reserveSeconds = 0,
  lock = false,
) {
  const rows = await tx.query(
    `SELECT source_id FROM liekan_crawler_range_source WHERE source_id='__refresh__'
    AND lease_token=$1::uuid AND lease_epoch=$2::bigint AND lease_until>clock_timestamp()+$3*interval '1 second'
    ${lock ? 'FOR SHARE' : ''}`,
    lease.token,
    lease.epoch,
    reserveSeconds,
  );
  return rows.length > 0;
}
export async function releaseCrawlerSourceLease(lease: CrawlerSourceLease) {
  await aiTransaction(tx =>
    tx.execute(
      "UPDATE liekan_crawler_range_source SET lease_token=NULL,lease_until=NULL WHERE source_id='__refresh__' AND lease_token=$1::uuid AND lease_epoch=$2::bigint",
      lease.token,
      lease.epoch,
    ),
  );
}

async function claim(
  source: RangeSource,
  force: boolean,
  sharedLease?: CrawlerSourceLease,
): Promise<Lease | null> {
  return aiTransaction(async tx => {
    const version = getPublishedCatalog()?.version;
    if (version && !(await registryVersionIsCurrent(tx, version))) return null;
    if (sharedLease && !(await crawlerSourceLeaseOwned(tx, sharedLease, 30, true))) return null;
    const token = randomUUID();
    const [state] = await tx.query(
      `UPDATE liekan_crawler_range_source SET lease_token=$2::uuid,lease_epoch=lease_epoch+1,
      lease_until=clock_timestamp()+interval '60 seconds',last_attempt_at=clock_timestamp()
      WHERE source_id=$1 AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND ($3 OR next_check_at<=clock_timestamp()) RETURNING *`,
      source.id,
      token,
      force,
    );
    if (!state) return null;
    const [row] = state.current_version
      ? await tx.query(
          'SELECT * FROM liekan_crawler_range_snapshot WHERE source_id=$1 AND version=$2',
          source.id,
          state.current_version,
        )
      : [];
    const content = row && contentFromRow(row);
    const observedAt = iso(state.current_observed_at);
    return {
      source,
      token,
      epoch: String(state.lease_epoch),
      ...(content && observedAt && isQualifiedRangeContent(source, content)
        ? { previous: { content, observedAt, etag: state.etag, lastModified: state.last_modified } }
        : {}),
    };
  });
}

export async function refreshRangeSource(
  sourceId: string,
  options: { force?: boolean; fetcher?: typeof fetch; sharedLease?: CrawlerSourceLease } = {},
) {
  const source = getRangeSources().find(source => source.id === sourceId);
  if (!source) throw new Error('Unknown range source');
  await initialize();
  const lease = await claim(source, options.force === true, options.sharedLease);
  if (!lease) return 'skipped' as const;
  let result: Awaited<ReturnType<typeof checkRangeSource>> | undefined;
  let errorCode: string | null = null;
  try {
    result = await checkRangeSource(source, lease.previous, { fetcher: options.fetcher });
  } catch (error) {
    errorCode = rangeCheckErrorCode(error);
  }
  return aiTransaction(async tx => {
    const version = getPublishedCatalog()?.version;
    if (version && !(await registryVersionIsCurrent(tx, version))) return 'superseded' as const;
    if (options.sharedLease && !(await crawlerSourceLeaseOwned(tx, options.sharedLease, 0, true)))
      return 'superseded' as const;
    const [state] = await tx.query(
      `SELECT * FROM liekan_crawler_range_source WHERE source_id=$1 AND lease_token=$2::uuid
      AND lease_epoch=$3::bigint AND lease_until>clock_timestamp() FOR UPDATE`,
      source.id,
      lease.token,
      lease.epoch,
    );
    if (!state) return 'superseded' as const;
    const good = result && result.status !== 'candidate';
    if (result) {
      await archive(tx, result.content, result.observedAt);
      if (good) {
        await observe(tx, result.content, result.observedAt);
        await mirror(tx, result.content, result.observedAt);
      }
    }
    await tx.execute(
      `UPDATE liekan_crawler_range_source SET
      current_version=CASE WHEN $4 THEN $5 ELSE current_version END,current_observed_at=CASE WHEN $4 THEN $6::timestamptz ELSE current_observed_at END,
      last_success_at=CASE WHEN $4 THEN $6::timestamptz ELSE last_success_at END,
      candidate_version=CASE WHEN $4 THEN NULL WHEN $7 THEN $5 ELSE candidate_version END,
      consecutive_failures=CASE WHEN $4 THEN 0 ELSE consecutive_failures+1 END,error_code=$8,
      etag=CASE WHEN $4 THEN $9 ELSE etag END,last_modified=CASE WHEN $4 THEN $10 ELSE last_modified END,
      next_check_at=clock_timestamp()+interval '1 hour',lease_token=NULL,lease_until=NULL
      WHERE source_id=$1 AND lease_token=$2::uuid AND lease_epoch=$3::bigint`,
      source.id,
      lease.token,
      lease.epoch,
      Boolean(good),
      result?.content.version ?? null,
      result?.observedAt ?? null,
      result?.status === 'candidate',
      good ? null : result?.candidateReason || errorCode || 'refresh_failed',
      result?.etag ?? null,
      result?.lastModified ?? null,
    );
    return result?.status ?? 'failed';
  });
}

export async function refreshRangeSources(options: { fetcher?: typeof fetch } = {}) {
  await initialize();
  const sources = getRangeSources();
  const sharedLease = await acquireCrawlerSourceLease(Math.ceil(sources.length / 2) * 15 + 180);
  if (!sharedLease) throw new CrawlerSourceBusyError();
  try {
    let cursor = 0;
    const outcomes = await Promise.allSettled(
      Array.from({ length: 2 }, async () => {
        while (cursor < sources.length) {
          const source = sources[cursor++];
          const owned = await aiTransaction(tx => crawlerSourceLeaseOwned(tx, sharedLease, 30), {
            readOnly: true,
          });
          if (!owned) return;
          await refreshRangeSource(source.id, { ...options, sharedLease });
        }
      }),
    );
    if (outcomes.some(outcome => outcome.status === 'rejected'))
      throw new Error('Range refresh persistence unavailable');
  } finally {
    await releaseCrawlerSourceLease(sharedLease);
  }
}

export async function readRangeSnapshots(): Promise<VerificationSnapshots> {
  await initialize();
  // Use the ingestion read boundary and release its connection before content qualification.
  const rows = await query(`SELECT r.*,s.current_observed_at FROM liekan_crawler_range_source s
      JOIN liekan_crawler_range_snapshot r ON r.source_id=s.source_id AND r.version=s.current_version`);
  const snapshots: VerificationSnapshots = {};
  for (const row of rows) {
    const source = getRangeSources().find(source => source.id === row.source_id);
    const content = contentFromRow(row);
    const observedAt = iso(row.current_observed_at);
    if (
      !source ||
      !observedAt ||
      +new Date(observedAt) > Date.now() ||
      (content.publishedAt && +new Date(content.publishedAt) > +new Date(observedAt)) ||
      !isQualifiedRangeContent(source, content)
    )
      continue;
    for (const name of content.names)
      snapshots[name] = {
        prefixes: content.prefixes,
        retrievedAt: observedAt,
        version: content.version,
        source: content.sourceUrl,
      };
  }
  return snapshots;
}

/** Internal recovery primitive: only a previously qualified observation can be restored. */
export async function restoreRangeSnapshot(sourceId: string, version: string) {
  const source = getRangeSources().find(source => source.id === sourceId);
  if (!source) throw new Error('Unknown range source');
  await initialize();
  return aiTransaction(async tx => {
    const catalogVersion = getPublishedCatalog()?.version;
    if (catalogVersion && !(await registryVersionIsCurrent(tx, catalogVersion)))
      throw new Error('Crawler catalog changed before range recovery');
    await tx.query(
      'SELECT source_id FROM liekan_crawler_range_source WHERE source_id=$1 FOR UPDATE',
      sourceId,
    );
    const [row] = await tx.query(
      `SELECT r.*,max(o.observed_at) AS qualified_at FROM liekan_crawler_range_snapshot r
      JOIN liekan_crawler_range_observation o ON o.source_id=r.source_id AND o.version=r.version
      WHERE r.source_id=$1 AND r.version=$2 GROUP BY r.source_id,r.version`,
      sourceId,
      version,
    );
    const content = row && contentFromRow(row),
      observedAt = iso(row?.qualified_at);
    if (
      !content ||
      !observedAt ||
      !isQualifiedRangeContent(source, content) ||
      +new Date(observedAt) > Date.now() ||
      (content.publishedAt && +new Date(content.publishedAt) > +new Date(observedAt))
    )
      throw new Error('Snapshot has no compatible qualified observation');
    await tx.execute(
      `UPDATE liekan_crawler_range_source SET current_version=$2,current_observed_at=$3::timestamptz,
      candidate_version=NULL,etag=NULL,last_modified=NULL,lease_epoch=lease_epoch+1,lease_token=NULL,lease_until=NULL,next_check_at=clock_timestamp()+interval '1 hour'
      WHERE source_id=$1`,
      sourceId,
      version,
      observedAt,
    );
    await mirror(tx, content, observedAt);
    return { sourceId, version, observedAt };
  });
}

export async function rangeSourceHealth(now = Date.now(), options: { initialize?: boolean } = {}) {
  if (options.initialize !== false) await initialize();
  const rows = await aiTransaction(
    tx =>
      tx.query(
        `SELECT s.*,r.version,r.source_url,r.parser_version,r.names,r.crawler_ids,r.prefixes,r.published_at FROM liekan_crawler_range_source s LEFT JOIN liekan_crawler_range_snapshot r ON r.source_id=s.source_id AND r.version=s.current_version`,
      ),
    { readOnly: true },
  );
  return getRangeSources().map(source => {
    const state = rows.find(row => row.source_id === source.id);
    const observedAt = iso(state?.current_observed_at),
      lastSuccessAt = iso(state?.last_success_at);
    const age = observedAt ? now - +new Date(observedAt) : Infinity;
    const qualified =
      state?.version &&
      observedAt &&
      (!state.published_at || +new Date(state.published_at) <= +new Date(observedAt)) &&
      isQualifiedRangeContent(source, contentFromRow(state));
    const status =
      !qualified || !observedAt
        ? 'missing'
        : age < 0 || age > 7 * DAY
          ? 'stale'
          : state.candidate_version
            ? 'review_required'
            : state.consecutive_failures >= 3 ||
                !lastSuccessAt ||
                now - +new Date(lastSuccessAt) > DAY
              ? 'warning'
              : state.error_code
                ? 'update_failed'
                : 'healthy';
    return {
      id: source.id,
      url: source.url,
      names: source.names,
      crawlerIds: source.crawlerIds,
      reviewedAt: source.reviewedAt,
      version: state?.current_version ?? null,
      candidateVersion: state?.candidate_version ?? null,
      observedAt,
      lastAttemptAt: iso(state?.last_attempt_at),
      lastSuccessAt,
      nextCheckAt: iso(state?.next_check_at),
      consecutiveFailures: state?.consecutive_failures ?? 0,
      errorCode: state?.error_code ?? null,
      status,
      reviewOverdue: now - +new Date(source.reviewedAt) > 45 * DAY,
    };
  });
}
