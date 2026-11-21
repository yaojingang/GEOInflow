import { DEFAULT_RESET_DATE } from '@/lib/constants';
import type { ControlSQL } from './control-db';

export type BrowserEventTime = { at: string; page: boolean };
export type BrowserPublication = {
  site: string;
  epoch: string;
  pointer: string;
  eventRows: number;
};

// Runs inside the accepted publication transaction. Replays stop at the existing
// publication barrier. A legacy or replacement candidate without complete append
// evidence withdraws the observation until the worker reconciles canonical facts.
export async function applyBrowserPresence(
  tx: ControlSQL,
  pub: BrowserPublication,
  events: BrowserEventTime[],
) {
  if (!pub.eventRows) return;
  const appended = pub.eventRows === events.length;
  await tx.query(
    `WITH events AS (SELECT * FROM jsonb_to_recordset($4::jsonb) e(at timestamptz,page boolean))
     INSERT INTO liekan_warehouse_browser_presence AS p
       (website_id,epoch,deletion_revision,publication,verified_through,pending_publications,verified,first_page_at,last_event_at)
     SELECT s.website_id,s.epoch,s.deletion_revision,s.publication,0,0,false,
       (SELECT min(at) FROM events WHERE page AND at>=w.created_at),
       (SELECT max(at) FROM events WHERE at >= $6::timestamptz)
     FROM liekan_warehouse_site s JOIN website w USING(website_id)
     WHERE s.website_id=$1 AND s.epoch=$2 AND s.publication=$3 AND s.state='active'
     ON CONFLICT(website_id) DO UPDATE SET
       epoch=excluded.epoch,deletion_revision=excluded.deletion_revision,publication=excluded.publication,
       verified=p.verified AND $5 AND (p.epoch,p.deletion_revision)=(excluded.epoch,excluded.deletion_revision),
       pending_publications=p.pending_publications+1,
       first_page_at=CASE WHEN $5 AND (p.epoch,p.deletion_revision)=(excluded.epoch,excluded.deletion_revision)
         THEN least(p.first_page_at,excluded.first_page_at) ELSE excluded.first_page_at END,
       last_event_at=CASE WHEN $5 AND (p.epoch,p.deletion_revision)=(excluded.epoch,excluded.deletion_revision)
         THEN greatest(p.last_event_at,excluded.last_event_at) ELSE excluded.last_event_at END
     WHERE (p.epoch,p.deletion_revision,p.publication)<(excluded.epoch,excluded.deletion_revision,excluded.publication)`,
    [
      pub.site,
      pub.epoch,
      pub.pointer,
      JSON.stringify(appended ? events : []),
      appended,
      DEFAULT_RESET_DATE + 'T00:00:00Z',
    ],
  );
}
