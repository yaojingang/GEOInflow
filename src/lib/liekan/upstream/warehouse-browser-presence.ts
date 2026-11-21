import { DEFAULT_RESET_DATE } from '@/lib/constants';
import { warehouseTime } from '../warehouse/fact-input';
import { factRelation } from '../warehouse/read';
import { warehouseReader } from '../warehouse/reader-runtime';
import { warehouseReportMetadata, warehouseReportQuery } from './warehouse-report-snapshot';

export async function readBrowserPresence(site: string) {
  const [row] = await warehouseReader().db.read<{
    received: boolean;
    known: boolean;
    lastAt: Date | null;
  }>(
    `SELECT coalesce(p.first_page_at<=now(),false) AS received,(p.verified OR coalesce(p.first_page_at<=now(),false)) AS known,p.last_event_at AS "lastAt"
     FROM liekan_warehouse_browser_presence p JOIN liekan_warehouse_site s USING(website_id)
     WHERE p.website_id=$1 AND s.state='active' AND p.epoch=s.epoch
       AND p.deletion_revision=s.deletion_revision AND p.publication<=s.publication`,
    [site],
  );
  return (
    row && { received: row.received, known: row.known, lastAt: row.lastAt?.toISOString() ?? null }
  );
}

// Only the worker reads facts. Log-only publications reuse the last browser
// observation. The earliest accepted page time handles future-dated events as
// time advances, without another scan or coupling to a selected report window.
export async function refreshBrowserPresence(site: { id: string; createdAt: Date }) {
  const { boundary: b } = await warehouseReportMetadata(site.id);
  const db = warehouseReader().db;
  const key = [site.id, b.epoch, b.deletionRevision, b.publication];
  const [state] = await db.read<{
    publication: string;
    verified: boolean;
    verified_through: string;
    pending_publications: string;
  }>(
    `SELECT publication,verified,verified_through,pending_publications FROM liekan_warehouse_browser_presence
      WHERE website_id=$1 AND epoch=$2 AND deletion_revision=$3`,
    key.slice(0, 3),
  );
  if (state && BigInt(state.publication) > BigInt(b.publication)) return;
  if (state?.verified) {
    if (state.verified_through === b.publication) return;
    // The count detects a missed older-version publisher during a rolling upgrade.
    // Ordinary browser and log appends therefore never reread all browser facts.
    const [changes] = await warehouseReportQuery<{ n: string }>(
      site.id,
      `SELECT uniqExact(publication) AS n FROM warehouse_publication WHERE website_id={wh_site:UUID}
      AND epoch={wh_epoch:UInt64} AND family='website_event'
      AND publication>{after:UInt64} AND publication<={wh_publication:UInt64}`,
      { after: state.verified_through },
    );
    if (String(changes.n) === String(state.pending_publications)) {
      await db.read(
        `UPDATE liekan_warehouse_browser_presence SET publication=$4,verified_through=$4,pending_publications=0
        WHERE website_id=$1 AND epoch=$2 AND deletion_revision=$3 AND publication=$5 AND verified_through=$6`,
        [...key, state.publication, state.verified_through],
      );
      return;
    }
  }
  const [row] = await warehouseReportQuery<{ firstAt: string | null; lastAt: string | null }>(
    site.id,
    `SELECT minOrNullIf(created_at,event_type NOT IN(2,5) AND created_at>={created:DateTime64(6)}) AS firstAt,
      maxOrNullIf(created_at,created_at>={reset:DateTime64(6)}) AS lastAt
      FROM ${factRelation('website_event', { columns: ['created_at', 'event_type'] })}`,
    { created: warehouseTime(site.createdAt), reset: warehouseTime(new Date(DEFAULT_RESET_DATE)) },
  );
  await db.read(
    `INSERT INTO liekan_warehouse_browser_presence AS p
       (website_id,epoch,deletion_revision,publication,verified_through,pending_publications,verified,first_page_at,last_event_at)
     SELECT website_id,epoch,deletion_revision,$4,$4,0,true,$5::timestamp AT TIME ZONE 'UTC',$6::timestamp AT TIME ZONE 'UTC'
       FROM liekan_warehouse_site WHERE website_id=$1 AND epoch=$2 AND deletion_revision=$3 AND publication>=$4 AND state='active'
     ON CONFLICT(website_id) DO UPDATE SET epoch=excluded.epoch,deletion_revision=excluded.deletion_revision,
       publication=excluded.publication,verified_through=excluded.verified_through,pending_publications=0,verified=true,
       first_page_at=excluded.first_page_at,last_event_at=excluded.last_event_at
     WHERE (excluded.epoch,excluded.deletion_revision,excluded.publication)>=(p.epoch,p.deletion_revision,p.publication)`,
    [...key, row.firstAt, row.lastAt],
  );
}
