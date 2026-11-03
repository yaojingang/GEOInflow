/**
 * Fence expanded policy views by physical event keys. Callers supply SQL predicates with
 * bound parameters; qualification stays in the authoritative effective-event view.
 * TABLE keeps physical key/presence reads outside the analytics policy rewriter and
 * respects the transaction's search_path (including isolated migration/test schemas).
 */
export function boundedBrowserEventsSql(
  condition: string,
  options: {
    geography?: boolean;
    environment?: boolean;
    entryBefore?: string;
    ranges?: 'raw_gaps' | 'visit_gaps';
    physicalKeys?: 'physical_page';
  } = {},
) {
  const { geography = false, environment = false, entryBefore, ranges, physicalKeys } = options;
  const history = geography || entryBefore !== undefined;
  const keys = `SELECT e.event_id FROM (TABLE website_event) e WHERE ${condition}`;
  return `bounded_keys AS MATERIALIZED(${physicalKeys ? `SELECT event_id FROM ${physicalKeys}` : ranges ? `SELECT k.event_id FROM ${ranges} g CROSS JOIN LATERAL(${keys} AND e.created_at>=g.starts AND e.created_at<g.ends OFFSET 0) k` : keys}),
 bounded_window AS MATERIALIZED(SELECT e.* FROM bounded_keys k CROSS JOIN LATERAL(
  SELECT e.* FROM liekan_effective_website_event e WHERE e.website_id=$1::uuid AND e.event_id=k.event_id OFFSET 0
 ) e JOIN (TABLE session) present ON present.website_id=e.website_id AND present.session_id=e.session_id),
 ${
   history
     ? `bounded_cohort AS MATERIALIZED(SELECT DISTINCT website_id,session_id,visit_id FROM bounded_window),
 bounded_history_candidates AS MATERIALIZED(SELECT h.event_id FROM bounded_cohort c CROSS JOIN LATERAL(
  SELECT e.event_id FROM (TABLE website_event) e WHERE e.website_id=c.website_id AND e.session_id=c.session_id AND e.visit_id=c.visit_id
   ${!geography && entryBefore ? `AND e.created_at<=${entryBefore}` : ''}
   OFFSET 0) h),
 bounded_history_keys AS MATERIALIZED(SELECT h.event_id FROM bounded_history_candidates h
  WHERE NOT EXISTS(SELECT 1 FROM bounded_keys k WHERE k.event_id=h.event_id)),
 bounded_history AS MATERIALIZED(SELECT * FROM bounded_window UNION ALL
  SELECT e.* FROM bounded_history_keys k CROSS JOIN LATERAL(
   SELECT e.* FROM liekan_effective_website_event e WHERE e.website_id=$1::uuid AND e.event_id=k.event_id OFFSET 0) e),
 `
     : ''
}${
   geography
     ? `bounded_anchor AS MATERIALIZED(SELECT DISTINCT ON(website_id,session_id,visit_id) website_id,session_id,visit_id,event_id
  FROM bounded_history WHERE event_type NOT IN(2,5) ORDER BY website_id,session_id,visit_id,created_at,event_id),
 `
     : ''
}${
   entryBefore !== undefined
     ? `bounded_entry AS MATERIALIZED(SELECT DISTINCT ON(website_id,session_id,visit_id) * FROM bounded_history
  WHERE event_type NOT IN(2,5) AND created_at<=${entryBefore} ORDER BY website_id,session_id,visit_id,created_at,event_id),
 `
     : ''
}bounded_events AS MATERIALIZED(SELECT e.*${
   geography
     ? `,
  CASE WHEN g.event_id IS NOT NULL THEN g.country ELSE raw_s.country END AS liekan_country,
  CASE WHEN g.event_id IS NOT NULL THEN g.region ELSE raw_s.region END AS liekan_region,
  CASE WHEN g.event_id IS NOT NULL THEN g.city ELSE raw_s.city END AS liekan_city`
     : ''
}${
   environment
     ? `,
  CASE WHEN e.event_type IN(3,4) THEN raw_s.browser ELSE env.browser END AS liekan_browser,
  CASE WHEN e.event_type IN(3,4) THEN raw_s.os ELSE env.os END AS liekan_os,
  CASE WHEN e.event_type IN(3,4) THEN raw_s.device ELSE env.device END AS liekan_device,
  CASE WHEN e.event_type IN(3,4) THEN raw_s.screen ELSE env.screen END AS liekan_screen,
  CASE WHEN e.event_type IN(3,4) THEN raw_s.language ELSE env.language END AS liekan_language,
  coalesce(env.identity_available,e.event_type IN(3,4)) AS liekan_identity_available`
     : ''
}
  FROM bounded_window e${geography || environment ? ' JOIN (TABLE session) raw_s ON raw_s.website_id=e.website_id AND raw_s.session_id=e.session_id' : ''}
  ${
    geography
      ? `LEFT JOIN bounded_anchor anchor ON anchor.website_id=e.website_id AND anchor.session_id=e.session_id AND anchor.visit_id=e.visit_id
  LEFT JOIN liekan_event_geography g ON g.website_id=e.website_id AND g.event_id=anchor.event_id`
      : ''
  }
  ${environment ? 'LEFT JOIN liekan_event_environment env ON env.website_id=e.website_id AND env.event_id=e.event_id' : ''})`;
}
