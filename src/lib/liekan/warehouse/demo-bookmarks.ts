import type { ControlSQL } from './control-db';
import type { DemoFactMapping } from './demo-mapping';

// The caller inserts the named demonstration bookmarks in this same transaction.
// Preserve exact ownership on resume; a conflicting previous owner is not replaced.
export async function writeDemoReplayBookmarkOwners(
  tx: ControlSQL,
  mapping: DemoFactMapping,
  bookmarks: Record<string, unknown>[],
) {
  const owners = bookmarks.map(row => mapping.replayBookmarkOwner(row));
  if (!owners.length) return;
  const expected = new Map(owners.map(row => [row.saved_replay_id, row]));
  if (expected.size !== owners.length) throw new Error('warehouse-demo-bookmark-duplicate');
  await tx.query(
    `INSERT INTO liekan_warehouse_replay_bookmark_owner(saved_replay_id,website_id,session_id)
    SELECT saved_replay_id,website_id,session_id FROM jsonb_to_recordset($1::jsonb)
      AS r(saved_replay_id uuid,website_id uuid,session_id uuid)
    ON CONFLICT DO NOTHING`,
    [JSON.stringify(owners)],
  );
  const rows = (
    await tx.query<{
      saved_replay_id: string;
      website_id: string;
      visit_id: string;
      session_id: string;
      owner_website_id: string;
    }>(
      `SELECT s.saved_replay_id,s.website_id,s.visit_id,o.session_id,o.website_id AS owner_website_id
    FROM session_replay_saved s LEFT JOIN liekan_warehouse_replay_bookmark_owner o USING(saved_replay_id)
    WHERE s.saved_replay_id=ANY($1::uuid[])`,
      [[...expected.keys()]],
    )
  ).rows;
  if (rows.length !== owners.length) throw new Error('warehouse-demo-bookmark-owner-conflict');
  for (const row of rows) {
    const owner = expected.get(row.saved_replay_id);
    if (
      !owner ||
      row.website_id !== owner.website_id ||
      row.visit_id !== owner.visit_id ||
      row.owner_website_id !== owner.website_id ||
      row.session_id !== owner.session_id
    )
      throw new Error('warehouse-demo-bookmark-owner-conflict');
    expected.delete(row.saved_replay_id);
  }
  if (expected.size) throw new Error('warehouse-demo-bookmark-owner-conflict');
}
