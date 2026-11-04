import type { ControlDatabase } from './control-db';
import type { SiteState } from './control';

// The temporary authority reads only bounded identity keys from its own facts.
// It does not wait for, or query, the CH shadow.
export function postgresLogLookup(db: ControlDatabase) {
  return (state: SiteState, ids: string[]) =>
    db.read<{ id: string; event_digest: string | null }>(
      'SELECT id,event_digest FROM liekan_log WHERE website_id=$1 AND id=ANY($2::text[])',
      [state.website_id, ids],
    );
}
export function postgresRecorderLookup(db: ControlDatabase) {
  return (state: SiteState, pairs: { sessionId: string; visitId: string }[]) =>
    db.read<{ session_id: string; visit_id: string }>(
      `SELECT DISTINCT session_id,visit_id FROM website_event WHERE website_id=$1
      AND (session_id,visit_id) IN(SELECT * FROM unnest($2::uuid[],$3::uuid[]))`,
      [state.website_id, pairs.map(p => p.sessionId), pairs.map(p => p.visitId)],
    );
}
