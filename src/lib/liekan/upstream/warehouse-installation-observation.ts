import { warehouseTime } from '../warehouse/fact-input';
import { factRelation } from '../warehouse/read';
import { warehouseReportQuery } from './warehouse-report-snapshot';

/** Original collection evidence, independent of eligibility, repair and exclusion rules. */
export function warehouseInstallationObservationSql() {
  return `SELECT toFloat64(count()) AS samples,
    toFloat64(countIf(env.scope='browser' AND env.identity_available AND notEmpty(coalesce(env.identity_version,'')))) AS available,
    toFloat64(countIf(isNull(env.event_id) OR empty(coalesce(env.identity_version,'')))) AS unknown,
    toFloat64(countIf(isNull(o.event_id))) AS fallback,
    maxOrNull(coalesce(o.received_at,q.created_at)) AS lastReceivedAt
    FROM ${factRelation('website_event', { columns: ['website_id', 'event_id', 'session_id', 'event_type'] })} e
    INNER JOIN ${factRelation('session', { columns: ['website_id', 'session_id'] })} s
      ON s.website_id=e.website_id AND s.session_id=e.session_id
    INNER JOIN ${factRelation('liekan_event_quality', { columns: ['website_id', 'event_id', 'source', 'created_at'] })} q
      ON q.website_id=e.website_id AND q.event_id=e.event_id
    LEFT JOIN ${factRelation('liekan_event_environment', { columns: ['website_id', 'event_id', 'scope', 'identity_available', 'identity_version'] })} env
      ON env.website_id=e.website_id AND env.event_id=e.event_id
    LEFT JOIN ${factRelation('liekan_event_observation', { columns: ['website_id', 'event_id', 'received_at'] })} o
      ON o.website_id=e.website_id AND o.event_id=e.event_id
    WHERE e.event_type=1 AND q.source IN('browser','legacy_override')
      AND coalesce(o.received_at,q.created_at)>={receivedStart:DateTime64(6,'UTC')}
      AND coalesce(o.received_at,q.created_at)<{receivedEnd:DateTime64(6,'UTC')}`;
}

export function normalizeWarehouseInstallationObservation(row?: Record<string, any>) {
  if (!row) return undefined;
  const count = (value: unknown) => {
    if (!(typeof value === 'number' || (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))))
      throw new Error('Invalid warehouse installation observation count');
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0)
      throw new Error('Invalid warehouse installation observation count');
    return number;
  };
  return {
    samples: count(row.samples),
    available: count(row.available),
    unknown: count(row.unknown),
    fallback: count(row.fallback),
    // CH DateTime64 JSON strings carry no zone; the schema and query use UTC.
    lastReceivedAt: row.lastReceivedAt
      ? new Date(row.lastReceivedAt.replace(' ', 'T') + 'Z')
      : null,
  };
}

export async function warehouseInstallationObservation(
  websiteId: string,
  startAt: number,
  endAt: number,
  signal: AbortSignal,
) {
  const [row] = await warehouseReportQuery<Record<string, any>>(
    websiteId,
    warehouseInstallationObservationSql(),
    {
      receivedStart: warehouseTime(new Date(startAt)),
      receivedEnd: warehouseTime(new Date(endAt)),
    },
    { signal, timeoutSeconds: 1 },
  );
  return normalizeWarehouseInstallationObservation(row);
}
