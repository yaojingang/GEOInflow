import { AsyncLocalStorage } from 'node:async_hooks';
import { getPublishedCatalog } from '../crawlers/published';
import { analysisDigest } from './analysis-query-model';
import { timedAnalyticsClient } from './analytics-deadline';
import { readAnalyticsVersions } from './analytics-revision';
import { analysisCapacity, analysisTransaction, findAnalysisVersions } from './analysis-rollups-db';
import type { AnalysisTx } from './analysis-rollups-model';
import {
  currentCacheContext,
  captureBrowserPopulations,
  noteBrowserPopulation,
} from './cache-context';
import { dashboardClock } from './dashboard-clock';
import { dashboardCapacityLockNamespace } from './dashboard-demand';
import { getQuerySnapshot } from './query-snapshot';
import { analyticsCacheKey, decodeAnalyticsResult, encodeAnalyticsResult } from './query-cache';
import { processSingleton } from './process-singleton';
import { hasAnalysisBuildCapacity } from './storage-capacity';

export const REPORT_FRAGMENT_FORMAT = 'report-fragment-v1';
export const reportFragmentLimits = Object.freeze({ entries: 200, bytes: 2 * 1024 ** 2, days: 7 });
type Identity = { epoch: string; namespace: string };
type Pending = Identity & {
  key: string;
  fingerprint: string;
  end: Date;
  bytes?: Buffer;
};
type State = {
  websiteId: string;
  identity?: Promise<Identity | undefined>;
  pins: Map<number, Promise<string>>;
  pending: Map<string, Pending>;
  disabled?: boolean;
  cacheReadFailed?: boolean;
};
const contexts = processSingleton('report-fragments', () => new AsyncLocalStorage<State>());
export const reportFragmentsActive = () => {
  const state = contexts.getStore();
  return Boolean(state && !state.disabled);
};

async function identity(tx: AnalysisTx, websiteId: string): Promise<Identity | undefined> {
  const [available] = await tx.$queryRawUnsafe<{ ready: boolean }[]>(
    "SELECT to_regclass('liekan_report_fragment') IS NOT NULL AS ready",
  );
  if (!available.ready) return;
  const [site] = await tx.$queryRawUnsafe<{ epoch: string; revision: string }[]>(
    `SELECT s.epoch::text,coalesce(r.revision,0)::text AS revision
     FROM liekan_analysis_site s LEFT JOIN liekan_analytics_revision r
       ON r.resource_type='website' AND r.resource_id=s.website_id
     WHERE s.website_id=$1::uuid AND s.mode='live'`,
    websiteId,
  );
  if (!site) return;
  const versions = await findAnalysisVersions(tx, websiteId);
  if (!versions) return;
  return {
    epoch: site.epoch,
    namespace: analyticsCacheKey(REPORT_FRAGMENT_FORMAT, [
      REPORT_FRAGMENT_FORMAT,
      site,
      versions,
      getPublishedCatalog()?.version,
      (await readAnalyticsVersions(tx, [`website:${websiteId}`])).strong,
    ]),
  };
}

async function fingerprint(tx: AnalysisTx, state: State, id: Identity, end: Date) {
  let pin = state.pins.get(+end);
  if (!pin) {
    pin = tx
      .$queryRawUnsafe<{ fingerprint: string }[]>(
        'SELECT liekan_dashboard_fingerprint_v2($1::uuid,$2::bigint,$3::timestamptz) AS fingerprint',
        state.websiteId,
        id.epoch,
        end,
      )
      .then(([row]) => row.fingerprint);
    state.pins.set(+end, pin);
  }
  return pin;
}

/** Only authorized private dashboard computations enter this scope. */
export async function withReportFragments<T>(
  websiteId: string,
  work: () => Promise<T>,
): Promise<T> {
  const context = currentCacheContext();
  if (
    !dashboardClock() ||
    getQuerySnapshot() ||
    process.env.CLICKHOUSE_URL ||
    !(context?.scope as { private?: boolean })?.private ||
    !context.actor ||
    !context.reauthorize
  )
    return work();
  const state: State = {
    websiteId,
    pins: new Map(),
    pending: new Map(),
  };
  return contexts.run(state, async () => {
    let value: T;
    try {
      value = await work();
    } catch (error) {
      if (!state.cacheReadFailed) throw error;
      // The failed source snapshot has closed. Retry once within the original request deadline.
      state.disabled = true;
      state.pending.clear();
      context.results.length = 0;
      context.populations?.clear();
      context.versions?.clear();
      const refresh = context.refresh;
      context.refresh = true;
      try {
        value = await work();
      } finally {
        context.refresh = refresh;
      }
    }
    // Save after the report transaction releases its read connection and source snapshot.
    if (!getQuerySnapshot() && (context.deadline || Infinity) - Date.now() > 1000)
      await persist(
        state,
        context.reauthorize,
        Math.min(context.deadline ?? Infinity, Date.now() + 750),
      );
    return value;
  });
}

/** Exact module identity permits reuse across chart changes and closed historical periods. */
export async function readReportFragment<T>(
  kind: string,
  start: Date,
  end: Date,
  parameters: unknown,
  load: () => Promise<T>,
  inclusiveEnd = false,
): Promise<T> {
  const state = contexts.getStore();
  const snapshot = getQuerySnapshot() as AnalysisTx | undefined;
  const key = analysisDigest([
    REPORT_FRAGMENT_FORMAT,
    kind,
    +start,
    +end,
    inclusiveEnd,
    parameters,
  ]);
  if (!state || state.disabled || !snapshot || !Number.isFinite(+start) || !Number.isFinite(+end))
    return load();
  const tx = timedAnalyticsClient(
    snapshot,
    currentCacheContext()?.deadline ?? Date.now() + 60000,
    false,
    () => {
      state.disabled = true;
      state.cacheReadFailed = true;
    },
  ) as AnalysisTx;
  const dependencyEnd = new Date(+end + (inclusiveEnd ? 1 : 0));
  let found: { id: Identity; pin: string; saved: { result: Uint8Array } | undefined };
  try {
    state.identity ??= identity(tx, state.websiteId);
    const id = await state.identity;
    if (!id) return load();
    const pin = await fingerprint(tx, state, id, dependencyEnd);
    const [saved] = await tx.$queryRawUnsafe<{ result: Uint8Array }[]>(
      `SELECT result FROM liekan_report_fragment WHERE website_id=$1::uuid AND query_key=$2
         AND epoch=$3::bigint AND namespace=$4 AND fingerprint=$5
         AND last_read_at>clock_timestamp()-interval '7 days'`,
      state.websiteId,
      key,
      id.epoch,
      id.namespace,
      pin,
    );
    found = { id, pin, saved };
  } catch (error) {
    state.disabled = true;
    throw error;
  }
  const { id, pin, saved } = found;
  if (saved) {
    try {
      const envelope = decodeAnalyticsResult(Buffer.from(saved.result));
      if (envelope.format === REPORT_FRAGMENT_FORMAT && Array.isArray(envelope.populations)) {
        for (const population of envelope.populations)
          noteBrowserPopulation(state.websiteId, population);
        state.pending.set(key, { ...id, key, fingerprint: pin, end: dependencyEnd });
        return envelope.value as T;
      }
    } catch {
      // An unreadable derived value is replaced by the ordinary exact computation.
    }
  }
  const envelope = await captureBrowserPopulations(load);
  for (const population of envelope.populations) noteBrowserPopulation(state.websiteId, population);
  if (envelope.value == null) return envelope.value;
  const bytes = encodeAnalyticsResult({ format: REPORT_FRAGMENT_FORMAT, ...envelope });
  if (bytes.length <= reportFragmentLimits.bytes)
    state.pending.set(key, { ...id, key, fingerprint: pin, end: dependencyEnd, bytes });
  return envelope.value;
}

async function persist(
  state: State,
  reauthorize: (deadline?: number) => Promise<boolean>,
  deadline: number,
) {
  if (state.disabled || !state.pending.size) return;
  try {
    if (!(await reauthorize(deadline))) return;
    await analysisTransaction(
      async tx => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout TO '100ms'");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout TO '750ms'");
        const [site] = await tx.$queryRawUnsafe(
          `SELECT s.website_id FROM website w JOIN liekan_analysis_site s USING(website_id)
         WHERE w.website_id=$1::uuid AND w.deleted_at IS NULL AND s.mode='live' FOR SHARE OF w,s`,
          state.websiteId,
        );
        if (!site) return;
        const [lock] = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
          `SELECT pg_try_advisory_xact_lock(${dashboardCapacityLockNamespace},hashtext($1::text)) AS locked`,
          state.websiteId,
        );
        if (!lock.locked) return;
        const current = await identity(tx, state.websiteId);
        if (!current) return;
        const pins: State = { ...state, pins: new Map() };
        await tx.$executeRawUnsafe(
          `DELETE FROM liekan_report_fragment WHERE website_id=$1::uuid
         AND (epoch<>$2::bigint OR namespace<>$3 OR last_read_at<clock_timestamp()-interval '7 days')`,
          state.websiteId,
          current.epoch,
          current.namespace,
        );
        for (const item of state.pending.values()) {
          if (Date.now() >= deadline) break;
          if (
            item.namespace !== current.namespace ||
            item.epoch !== current.epoch ||
            item.fingerprint !== (await fingerprint(tx, pins, current, item.end))
          )
            continue;
          if (!item.bytes) {
            await tx.$executeRawUnsafe(
              'UPDATE liekan_report_fragment SET last_read_at=clock_timestamp() WHERE website_id=$1::uuid AND query_key=$2 AND fingerprint=$3',
              state.websiteId,
              item.key,
              item.fingerprint,
            );
            continue;
          }
          const capacity = await analysisCapacity(tx, state.websiteId);
          if (
            !hasAnalysisBuildCapacity({
              ...capacity,
              siteBytes: String(BigInt(capacity.siteBytes) + BigInt(item.bytes.length * 2)),
              globalBytes: String(BigInt(capacity.globalBytes) + BigInt(item.bytes.length * 2)),
            })
          )
            continue;
          await tx.$executeRawUnsafe(
            `DELETE FROM liekan_report_fragment WHERE website_id=$1::uuid AND query_key IN(
           SELECT query_key FROM liekan_report_fragment WHERE website_id=$1::uuid AND query_key<>$2
           ORDER BY last_read_at DESC OFFSET 199)`,
            state.websiteId,
            item.key,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO liekan_report_fragment(website_id,query_key,epoch,namespace,fingerprint,dependency_end,result,result_bytes)
           VALUES($1::uuid,$2,$3::bigint,$4,$5,$6,$7,$8)
           ON CONFLICT(website_id,query_key) DO UPDATE SET epoch=EXCLUDED.epoch,namespace=EXCLUDED.namespace,
           fingerprint=EXCLUDED.fingerprint,dependency_end=EXCLUDED.dependency_end,result=EXCLUDED.result,
           result_bytes=EXCLUDED.result_bytes,generated_at=clock_timestamp(),last_read_at=clock_timestamp()`,
            state.websiteId,
            item.key,
            item.epoch,
            item.namespace,
            item.fingerprint,
            item.end,
            item.bytes,
            item.bytes.length,
          );
        }
      },
      'ReadCommitted',
      deadline,
    );
  } catch {
    // Derived-cache contention or an unavailable write connection leaves the computed report usable.
  }
}
