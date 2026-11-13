import { hasPermission } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/constants';
import { isRelationalOnly } from '@/lib/db';
import type { InstallationIdentityObservation } from '../contracts/installation';
import { aiTransaction, type AiTx } from './ai-db';
import { databaseSchema } from './database-schema';
import { LiekanError } from './errors';
import { warehouseEnabled, withinWarehouseAuthority } from '../warehouse/authority-routing';

export const INSTALLATION_OBSERVATION_BUDGET_MS = 2000;
const transactionBudget = 1750;
const accessSql = `SELECT w.user_id AS "ownerId",w.team_id AS "teamId",u.user_id AS "userId",u.role,
  tu.role AS "teamRole",coalesce(s.is_demo,false) AS demo
  FROM website w LEFT JOIN "user" u ON u.user_id=$2::uuid AND u.deleted_at IS NULL
  LEFT JOIN team t ON t.team_id=w.team_id AND t.deleted_at IS NULL
  LEFT JOIN team_user tu ON tu.team_id=t.team_id AND tu.user_id=u.user_id
  LEFT JOIN liekan_setting s ON s.website_id=w.website_id
  WHERE w.website_id=$1::uuid AND w.deleted_at IS NULL`;

async function readAccess(tx: AiTx, websiteId: string, userId: string) {
  const [row] = await tx.query(accessSql, websiteId, userId);
  if (!row) throw new LiekanError('站点不存在', 404);
  if (!row.userId) throw new LiekanError('需要完整登录', 401);
  if (
    !(await hasPermission(row.role, PERMISSIONS.all)) &&
    row.ownerId !== userId &&
    !(row.teamId && row.teamRole)
  )
    throw new LiekanError('无权访问该站点', 403);
  return row;
}

/** Both branches use receipt indexes, including the original quality-time fallback. */
export function installationObservationSql(schema = databaseSchema()) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid database schema');
  return `WITH received AS MATERIALIZED (
    SELECT o.website_id,o.event_id,o.received_at,false AS fallback
    FROM liekan_event_observation o
    WHERE o.website_id=$1::uuid AND o.received_at>=$2::timestamptz AND o.received_at<$3::timestamptz
    UNION ALL
    SELECT q.website_id,q.event_id,q.created_at,true AS fallback
    FROM liekan_event_quality q
    WHERE q.website_id=$1::uuid AND q.created_at>=$2::timestamptz AND q.created_at<$3::timestamptz
      AND NOT EXISTS(SELECT 1 FROM liekan_event_observation o WHERE o.event_id=q.event_id AND o.website_id=q.website_id)
  ) SELECT count(*)::float8 AS samples,
    count(*) FILTER(WHERE env.scope='browser' AND env.identity_available AND nullif(env.identity_version,'') IS NOT NULL)::float8 AS available,
    count(*) FILTER(WHERE env.event_id IS NULL OR nullif(env.identity_version,'') IS NULL)::float8 AS unknown,
    count(*) FILTER(WHERE r.fallback)::float8 AS fallback,max(r.received_at) AS "lastReceivedAt"
    FROM received r
    JOIN liekan_raw_website_event e ON e.website_id=r.website_id AND e.event_id=r.event_id
    JOIN "${schema}"."session" s ON s.website_id=e.website_id AND s.session_id=e.session_id
    JOIN liekan_event_quality q ON q.website_id=e.website_id AND q.event_id=e.event_id
    LEFT JOIN liekan_event_environment env ON env.website_id=e.website_id AND env.event_id=e.event_id
    WHERE e.website_id=$1::uuid AND e.event_type=1 AND q.source IN('browser','legacy_override')`;
}

export function installationObservationFromRow(
  row: Record<string, any>,
  base: InstallationIdentityObservation,
): InstallationIdentityObservation {
  const counts = [row?.samples, row?.available, row?.unknown, row?.fallback];
  if (counts.some(value => !Number.isSafeInteger(value) || value < 0))
    throw new Error('Invalid installation observation counts');
  const [samples, available, unknown, fallback] = counts;
  if (available + unknown > samples || fallback > samples)
    throw new Error('Inconsistent installation observation counts');
  const lastReceivedAt = row.lastReceivedAt ? new Date(row.lastReceivedAt).toISOString() : null;
  const status = !samples
    ? 'empty'
    : unknown
      ? 'unknown'
      : available === samples
        ? 'complete'
        : available
          ? 'partial'
          : 'unavailable';
  const reasons: InstallationIdentityObservation['reasons'] = [];
  if (!samples) reasons.push('no_received_samples');
  if (samples > 0 && samples < 20) reasons.push('small_sample');
  if (unknown) reasons.push('identity_evidence_missing');
  if (status === 'partial') reasons.push('partial_identity');
  if (status === 'unavailable') reasons.push('identity_input_unavailable');
  if (fallback) reasons.push('reception_fallback');
  return {
    ...base,
    status,
    sampleCount: samples,
    availableIdentityCount: available,
    unknownIdentityCount: unknown,
    coverage: samples && !unknown ? available / samples : null,
    lastReceivedAt,
    smallSample: samples > 0 && samples < 20,
    reasons,
  };
}

export async function readInstallationObservation(
  websiteId: string,
  userId: string,
  endAt = Date.now(),
): Promise<InstallationIdentityObservation> {
  const base: InstallationIdentityObservation = {
    version: 'received-browser-identity-v1',
    timeBasis: 'received_at',
    population: 'raw_public_pv',
    range: { startAt: endAt - 30 * 60 * 1000, endAt, timezone: 'UTC', endExclusive: true },
    status: 'temporarily_unavailable',
    sampleCount: null,
    availableIdentityCount: null,
    unknownIdentityCount: null,
    coverage: null,
    lastReceivedAt: null,
    smallSample: null,
    reasons: ['diagnostic_unavailable'],
  };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    // The warehouse admission queue and cross-database fences are part of the
    // diagnostic budget. Abort an expired query without turning absence into zero.
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Installation observation timed out');
        controller.abort(error);
        reject(error);
      }, INSTALLATION_OBSERVATION_BUDGET_MS);
      timer.unref?.();
    });
    return await Promise.race([
      withinWarehouseAuthority(async () => {
        controller.signal.throwIfAborted();
        if (!warehouseEnabled() && !isRelationalOnly())
          return {
            ...base,
            status: 'unsupported' as const,
            reasons: ['unsupported_database' as const],
          };
        return aiTransaction<InstallationIdentityObservation>(
          async tx => {
            controller.signal.throwIfAborted();
            const access = await readAccess(tx, websiteId, userId);
            if (access.demo) return { ...base, status: 'demo', reasons: ['demo_data'] };
            controller.signal.throwIfAborted();
            const row = warehouseEnabled()
              ? await (
                  await import('./warehouse-installation-observation')
                ).warehouseInstallationObservation(
                  websiteId,
                  base.range.startAt,
                  base.range.endAt,
                  controller.signal,
                )
              : (
                  await tx.query(
                    installationObservationSql(),
                    websiteId,
                    new Date(base.range.startAt),
                    new Date(base.range.endAt),
                  )
                )[0];
            controller.signal.throwIfAborted();
            const current = await readAccess(tx, websiteId, userId);
            if (
              ['ownerId', 'teamId', 'role', 'teamRole', 'demo'].some(
                field => access[field] !== current[field],
              )
            )
              throw new LiekanError('站点读取权限已变更', 403);
            return installationObservationFromRow(row, base);
          },
          {
            readOnly: true,
            timeout: transactionBudget,
            transactionTimeout: transactionBudget,
            maxWait: INSTALLATION_OBSERVATION_BUDGET_MS - transactionBudget,
          },
        );
      }),
      expired,
    ]);
  } catch (error) {
    if (error instanceof LiekanError && [401, 403, 404].includes(error.status)) throw error;
    const timeout =
      ['P2028', '57014'].includes((error as any)?.code) ||
      /timeout|timed out|Unable to start a transaction/i.test(String((error as any)?.message));
    return { ...base, reasons: [timeout ? 'diagnostic_timeout' : 'diagnostic_unavailable'] };
  } finally {
    clearTimeout(timer);
  }
}
