import {
  warehouseBookmarkProjection,
  warehouseBookmarkValues,
} from './warehouse-bookmark-projection';
import { warehouseFeatureQuery } from './warehouse-feature-analytics';
export async function warehouseFeatureReplays(
  websiteId: string,
  p: any,
  cte: string,
  params: Record<string, unknown>,
) {
  const bookmarks = await warehouseBookmarkProjection(websiteId);
  const sql = `${cte},saved AS ${warehouseBookmarkValues},replay_visits AS(SELECT DISTINCT visit_id,session_id FROM session_replay ${p.saved === '1' ? 'WHERE visit_id IN(SELECT visit_id FROM saved)' : ''}),
    matching_visits AS(SELECT e.visit_id,e.session_id,countIf(event_type=1) AS pageviews,
      argMin(tuple(referrer_domain),tuple(created_at,event_id)).1 AS referrerDomain,
      argMax(tuple(liekan_browser,liekan_device),tuple(created_at,event_id)) AS environment
      FROM selected e INNER JOIN replay_visits r USING(visit_id,session_id) GROUP BY e.visit_id,e.session_id),
    recordings AS(SELECT r.visit_id AS id,r.visit_id AS visitId,r.session_id AS sessionId,minOrNull(r.started_at) AS startedAt,maxOrNull(r.ended_at) AS endedAt,
      (toUnixTimestamp64Micro(max(r.ended_at))-toUnixTimestamp64Micro(min(r.started_at)))/1000.0 AS duration,
      sum(r.event_count) AS eventCount,count() AS chunkCount,max(m.pageviews) AS pageviews,max(m.referrerDomain) AS referrerDomain,
      max(m.environment.2) AS device,max(m.environment.1) AS browser,max(s.name) AS name
      FROM session_replay r INNER JOIN matching_visits m USING(visit_id,session_id) LEFT JOIN saved s ON s.visit_id=r.visit_id
      ${p.saved === '1' ? 'WHERE s.visit_id IS NOT NULL' : ''} GROUP BY r.visit_id,r.session_id)`;
  const query = { ...params, ...bookmarks, websiteId, offset: (p.page - 1) * 25 };
  const [count] = await warehouseFeatureQuery(
    `${sql} SELECT count() AS count FROM recordings`,
    query,
  );
  const rows = await warehouseFeatureQuery(
    `${sql} SELECT * FROM recordings ORDER BY startedAt DESC,id LIMIT 25 OFFSET {offset:UInt64}`,
    query,
  );
  return { rows, count: count.count, page: p.page, pageSize: 25 };
}
