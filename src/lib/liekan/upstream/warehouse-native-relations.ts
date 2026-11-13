import { factTable, identifier } from '../warehouse/catalog';
import { factRelation } from '../warehouse/read';
import {
  geographicEventRelation,
  sessionLinkRelation,
  sessionPropertyRelation,
} from '../warehouse/reporting-relations';

export function nativeRelations() {
  const columns = (family: string, alias: string) =>
    factTable(family)
      .columns.map(c => `${alias}.${identifier(c.name)} AS ${identifier(c.name)}`)
      .join(',');
  const arrays = [
    'hostname',
    'url_path',
    'url_query',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'referrer_domain',
    'page_title',
    'gclid',
    'fbclid',
    'msclkid',
    'ttclid',
    'li_fat_id',
    'twclid',
    'event_name',
    'tag',
  ];
  return [
    `website_event AS (SELECT *,liekan_country AS country,liekan_region AS region,liekan_city AS city,
      liekan_browser AS browser,liekan_os AS os,liekan_device AS device,liekan_screen AS screen,
      liekan_language AS language,liekan_distinct_id AS distinct_id FROM ${geographicEventRelation()})`,
    `heatmap_event AS ${factRelation('heatmap_event')}`,
    `session_replay AS ${factRelation('session_replay')}`,
    `event_data AS (SELECT ${columns('event_data', 'd')},d.website_event_id AS event_id,e.session_id,e.event_name,e.url_path FROM ${factRelation('event_data')} d
      INNER JOIN website_event e ON e.website_id=d.website_id AND e.event_id=d.website_event_id)`,
    `session_data AS ${sessionPropertyRelation()}`,
    `session_link AS ${sessionLinkRelation()}`,
    `website_revenue AS (SELECT ${columns('revenue', 'r')},e.url_path,e.visit_id FROM ${factRelation('revenue')} r
      INNER JOIN website_event e ON e.website_id=r.website_id AND e.event_id=r.event_id)`,
    // This is a query projection, not a second permanent per-path fact store.
    // One event per row also preserves sub-hour range boundaries accurately.
    `website_event_stats_hourly AS (SELECT e.* EXCEPT(${arrays.join(',')}),
      ${arrays.map(c => `${c === 'event_name' ? "if(e.event_type=2,[coalesce(e.event_name,'')],[])" : `arrayFilter(v->v!=''${c === 'referrer_domain' ? " AND v!=coalesce(e.hostname,'')" : ''},[coalesce(e.${c},'')])`} AS ${c}`).join(',')},
      toUInt64(event_type NOT IN(2,5)) AS views,created_at AS min_time,created_at AS max_time,
      arrayReduce('argMinState',[coalesce(e.url_path,'')],[e.created_at]) AS entry_url,
      arrayReduce('argMaxState',[coalesce(e.url_path,'')],[e.created_at]) AS exit_url FROM website_event e)`,
    `event_data_pivot AS (SELECT website_id,session_id,event_id,event_name,url_path,created_at,
      groupArrayState(data_key) AS property_keys,
      groupArrayState(multiIf(data_type IN(1,3,5),coalesce(string_value,''),data_type=2,toString(coalesce(number_value,0)),data_type=4,toString(coalesce(date_value,toDateTime64(0,6))),'')) AS property_values,
      groupArrayState(toUInt32(data_type)) AS property_types FROM event_data
      GROUP BY website_id,session_id,event_id,event_name,url_path,created_at)`,
  ];
}
