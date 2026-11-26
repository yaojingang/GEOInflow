import { warehouseEnabled } from '@/lib/liekan/warehouse/authority-routing';
import {
  GEO_CONTENT_TYPES,
  GEO_METADATA_PATH,
  GEO_NON_CONTENT_EXTENSION,
  GEO_SCOPE,
} from '../geo-weight/policy';
import type { AiTx } from './ai-db';

// Path/day distinct operations stay in the active analytical backend. No Top-N feeds a score.
export async function geoWeightAggregate(
  tx: AiTx,
  websiteId: string,
  hostname: string,
  timezone: string,
  windows: Array<{ asOf: string; startAt: number; endAt: number }>,
) {
  if (warehouseEnabled())
    return (await import('./warehouse-geo-weight')).warehouseGeoWeightAggregate(
      tx,
      websiteId,
      hostname,
      timezone,
      windows,
    );
  return tx.query(
    `WITH windows AS (
      SELECT * FROM jsonb_to_recordset($2::jsonb) AS w("asOf" text,"startAt" timestamptz,"endAt" timestamptz)
    ), policy AS (
      SELECT * FROM jsonb_to_recordset($5::jsonb) AS p(id text,purpose text,"platformId" text)
    ), raw AS MATERIALIZED (
      SELECT l.id,l.created_at,l.path,l.method,l.status,l.source_id,l.ai_eligible,l.recognition_state,
        l.verification,l.verification_version,l.verification_observed_at,l.verification_reason,
        l.user_agent LIKE 'Liekan-Crawler-Check/%' AS self_check,
        e.crawler_id,e.catalog_version,e.classification_version,e.measurement,e.identity_evidence,
        e.edge_observation#>>'{fields,EdgeResponseContentType,state}' AS mime_state,
        e.edge_observation#>>'{fields,EdgeResponseContentType,value}' AS mime,
        r.version IS NOT NULL AND r.catalog_version=e.catalog_version AND r.crawler_configuration IS NOT NULL AS rule_available
      FROM liekan_effective_log l
      LEFT JOIN liekan_crawler_evidence e ON e.website_id=l.website_id AND e.log_id=l.id
      LEFT JOIN liekan_crawler_rule_version r ON r.website_id=e.website_id AND r.version=e.classification_version
      WHERE l.website_id=$1::uuid
        AND l.created_at >= (SELECT min("startAt") FROM windows)
        AND l.created_at < (SELECT max("endAt") FROM windows)
    ), catalogs AS MATERIALIZED (
      SELECT v.version,v.payload FROM liekan_crawler_registry_version v
      JOIN (SELECT DISTINCT catalog_version FROM raw) r ON r.catalog_version=v.version
    ), identities AS MATERIALIZED (
      SELECT c.version,i.identity FROM catalogs c
      CROSS JOIN LATERAL jsonb_array_elements(c.payload->'identities') i(identity)
    ), range_bindings AS MATERIALIZED (
      SELECT DISTINCT c.version AS catalog_version,rs.version AS verification_version,ids.id AS crawler_id
      FROM catalogs c
      CROSS JOIN LATERAL jsonb_array_elements(c.payload->'rangeSources') s(source)
      JOIN liekan_crawler_range_snapshot rs ON rs.source_id=s.source->>'id' AND rs.source_url=s.source->>'url'
      JOIN (SELECT DISTINCT verification_version FROM raw) used ON used.verification_version=rs.version
      CROSS JOIN LATERAL jsonb_array_elements_text(rs.crawler_ids) ids(id)
      WHERE s.source->'crawlerIds' ? ids.id AND s.source->>'enabled' IS DISTINCT FROM 'false'
    ), evaluated AS MATERIALIZED (
      SELECT r.created_at,r.path,r.status,r.source_id,r.ai_eligible,r.recognition_state,
        r.verification,r.verification_version,r.self_check,r.crawler_id,r.catalog_version,r.classification_version,r.mime_state,
        r.measurement->>'host'=$3 AS host_matches,
        r.measurement->>'hostBasis' IS DISTINCT FROM 'request_host' AS inferred_host,
        (r.measurement->>'samplingTimeBasis' IS DISTINCT FROM 'event_time'
          OR r.measurement->>'samplingBasis' IS DISTINCT FROM 'observed_provider_config'
          OR r.measurement->'samplingRate' IS DISTINCT FROM '1'::jsonb) AS sampling_unknown,
        r.identity_evidence->>'reason'='identity_conflict' AS identity_conflict,
        p.purpose,p."platformId",i.identity->>'productForm' AS form,
        c.version IS NOT NULL AND r.rule_available AS history_available,
        CASE
          WHEN r.self_check THEN 'self_check'
          WHEN r.measurement->>'host' IS NULL OR lower(r.measurement->>'host')<>$3
            OR coalesce(r.measurement->>'hostBasis','') NOT IN('request_host','configured_host','declared_host') THEN 'host'
          WHEN r.recognition_state='ambiguous' OR r.identity_evidence->>'reason'='identity_conflict' THEN 'ambiguous'
          WHEN p.id IS NULL THEN 'outside_scope'
          WHEN i.version IS NULL OR NOT r.rule_available THEN 'history'
          WHEN r.recognition_state IS DISTINCT FROM 'recognized' OR r.ai_eligible IS DISTINCT FROM true
            OR i.identity->>'status' IS DISTINCT FROM 'active'
            OR i.identity->>'kind' IS DISTINCT FROM 'http_crawler'
            OR i.identity->>'aiEligible' IS DISTINCT FROM 'true'
            OR i.identity#>>'{metadata,evidence}' IS DISTINCT FROM 'operator'
            OR i.identity->>'purpose' IS DISTINCT FROM p.purpose
            OR i.identity->>'platformId' IS DISTINCT FROM p."platformId" THEN 'semantics'
          WHEN r.verification IS DISTINCT FROM 'verified_range'
            OR r.verification_reason IS DISTINCT FROM 'verified_range'
            OR r.verification_observed_at IS NULL
            OR abs(extract(epoch FROM r.created_at-r.verification_observed_at))>604800
            OR rb.verification_version IS NULL THEN 'verification'
          WHEN r.method<>'GET' OR r.status NOT IN(200,304) THEN 'response'
          WHEN r.path ~* $6 OR r.mime_state='invalid'
            OR (r.mime_state='present' AND NOT(coalesce(r.mime,'')=ANY($8::text[])))
            OR (coalesce(r.mime_state,'unknown')<>'present' AND r.path ~* $7) THEN 'content'
          ELSE NULL END AS exclusion
      FROM raw r LEFT JOIN policy p ON p.id=r.crawler_id
      LEFT JOIN catalogs c ON c.version=r.catalog_version
      LEFT JOIN identities i ON i.version=r.catalog_version AND i.identity->>'id'=r.crawler_id
      LEFT JOIN range_bindings rb ON rb.catalog_version=r.catalog_version
        AND rb.verification_version=r.verification_version AND rb.crawler_id=r.crawler_id
    ), scoped AS MATERIALIZED (
      SELECT w."asOf",e.*,(e.created_at AT TIME ZONE $4)::date AS day
      FROM windows w JOIN evaluated e ON e.created_at>=w."startAt" AND e.created_at<w."endAt"
    ), units AS MATERIALIZED (
      SELECT DISTINCT "asOf",purpose,"platformId",path,day FROM scoped WHERE exclusion IS NULL
    ), operators AS (
      SELECT "asOf",purpose,"platformId",count(*)::float8 AS units,count(DISTINCT day)::int AS days
      FROM units GROUP BY 1,2,3
    ), factors AS (
      SELECT u."asOf",u.purpose,count(DISTINCT u.path)::float8 AS paths,count(*)::float8 AS units,
        count(DISTINCT u.day)::int AS days,
        (SELECT count(*) FROM operators o WHERE o."asOf"=u."asOf" AND o.purpose=u.purpose AND o.units>=10 AND o.days>=3)::int AS operators
      FROM units u GROUP BY 1,2
    ), excluded AS (
      SELECT "asOf",exclusion,count(*)::float8 AS count FROM scoped WHERE exclusion IS NOT NULL GROUP BY 1,2
    ), identity_exclusions AS MATERIALIZED (
      SELECT "asOf",crawler_id,exclusion,count(*)::float8 AS count FROM scoped
      WHERE crawler_id IS NOT NULL AND exclusion IS NOT NULL AND NOT self_check GROUP BY 1,2,3
    ), identity_exclusion_totals AS MATERIALIZED (
      SELECT "asOf",crawler_id,jsonb_object_agg(exclusion,count) AS exclusions
      FROM identity_exclusions GROUP BY 1,2
    ), identity_counts AS (
      SELECT "asOf",crawler_id AS id,count(*)::float8 AS requests,
        count(*) FILTER(WHERE verification='verified_range' AND recognition_state='recognized')::float8 AS verified,
        count(*) FILTER(WHERE exclusion IS NULL)::float8 AS accepted
      FROM scoped WHERE crawler_id IS NOT NULL AND NOT self_check GROUP BY 1,2
    ), seen AS MATERIALIZED (
      SELECT s.*,coalesce(x.exclusions,'{}') AS exclusions FROM identity_counts s
      LEFT JOIN identity_exclusion_totals x ON x."asOf"=s."asOf" AND x.crawler_id=s.id
    ), forms AS (
      SELECT "asOf",form,count(*)::float8 AS requests FROM scoped
      WHERE form IN('workbench','personal_agent') AND history_available AND NOT self_check
        AND exclusion IS DISTINCT FROM 'host'
        AND recognition_state='recognized' AND identity_conflict IS DISTINCT FROM true
      GROUP BY 1,2
    ), stats AS (
      SELECT "asOf",count(*)::float8 AS requests,
        count(*) FILTER(WHERE exclusion IS NULL)::float8 AS accepted,
        count(*) FILTER(WHERE exclusion IS NULL AND status=200)::float8 AS "status200",
        count(*) FILTER(WHERE exclusion IS NULL AND status=304)::float8 AS "status304",
        count(*) FILTER(WHERE exclusion IS NULL AND mime_state='present')::float8 AS "mimeConfirmed",
        count(*) FILTER(WHERE exclusion IS NULL AND coalesce(mime_state,'unknown')<>'present')::float8 AS "pathInferred",
        count(*) FILTER(WHERE NOT self_check AND inferred_host)::float8 AS "inferredHost",
        count(*) FILTER(WHERE NOT self_check AND sampling_unknown)::float8 AS "samplingUnknown",
        count(*) FILTER(WHERE NOT self_check AND (history_available IS DISTINCT FROM true OR exclusion='history'))::float8 AS "historyMissing",
        count(*) FILTER(WHERE NOT self_check AND (exclusion IN('ambiguous','history','semantics','verification')
          OR recognition_state IS DISTINCT FROM 'recognized' AND ai_eligible IS DISTINCT FROM false))::float8 AS "identityMissing",
        min(day) FILTER(WHERE history_available AND NOT self_check AND host_matches)::text AS "firstEvidenceDay",
        coalesce(array_agg(DISTINCT catalog_version::text ORDER BY catalog_version::text) FILTER(WHERE catalog_version IS NOT NULL AND NOT self_check),'{}') AS "catalogVersions",
        coalesce(array_agg(DISTINCT classification_version ORDER BY classification_version) FILTER(WHERE classification_version IS NOT NULL AND NOT self_check),'{}') AS "classificationVersions",
        coalesce(array_agg(DISTINCT verification_version ORDER BY verification_version) FILTER(WHERE verification_version IS NOT NULL AND NOT self_check),'{}') AS "verificationVersions",
        coalesce(array_agg(DISTINCT coalesce(source_id::text,'manual') ORDER BY coalesce(source_id::text,'manual')) FILTER(WHERE NOT self_check),'{}') AS sources
      FROM scoped GROUP BY 1
    ) SELECT w."asOf",to_jsonb(s)-'asOf' AS stats,
      coalesce((SELECT jsonb_agg(to_jsonb(f)-'asOf' ORDER BY f.purpose) FROM factors f WHERE f."asOf"=w."asOf"),'[]') AS factors,
      coalesce((SELECT jsonb_agg(to_jsonb(o)-'asOf' ORDER BY o.purpose,o."platformId") FROM operators o WHERE o."asOf"=w."asOf"),'[]') AS operators,
      coalesce((SELECT jsonb_object_agg(x.exclusion,x.count) FROM excluded x WHERE x."asOf"=w."asOf"),'{}') AS exclusions,
      coalesce((SELECT jsonb_agg(to_jsonb(x)-'asOf' ORDER BY x.id) FROM seen x WHERE x."asOf"=w."asOf"),'[]') AS identities,
      coalesce((SELECT jsonb_agg(to_jsonb(x)-'asOf' ORDER BY x.form) FROM forms x WHERE x."asOf"=w."asOf"),'[]') AS forms
      FROM windows w LEFT JOIN stats s ON s."asOf"=w."asOf" ORDER BY w."asOf"`,
    websiteId,
    JSON.stringify(
      windows.map(w => ({
        ...w,
        startAt: new Date(w.startAt).toISOString(),
        endAt: new Date(w.endAt).toISOString(),
      })),
    ),
    hostname,
    timezone,
    JSON.stringify(GEO_SCOPE),
    GEO_METADATA_PATH,
    GEO_NON_CONTENT_EXTENSION,
    GEO_CONTENT_TYPES,
  );
}

// An indexed, time-budgeted first-input lookup establishes span without changing score counts.
export async function geoWeightFirstEvidence(
  tx: AiTx,
  websiteId: string,
  hostname: string,
  timezone: string,
  endAt: number,
) {
  if (warehouseEnabled())
    return (await import('./warehouse-geo-weight')).warehouseGeoWeightFirstEvidence(
      tx,
      websiteId,
      hostname,
      timezone,
      endAt,
    );
  const [earliest] = await tx.query(
    `SELECT (l.created_at AT TIME ZONE $3)::date::text AS day
          FROM liekan_effective_log l JOIN liekan_crawler_evidence e ON e.website_id=l.website_id AND e.log_id=l.id
          JOIN liekan_crawler_rule_version r ON r.website_id=e.website_id AND r.version=e.classification_version
          JOIN liekan_crawler_registry_version c ON c.version=e.catalog_version AND c.version=r.catalog_version
          WHERE l.website_id=$1::uuid AND l.created_at<$4::timestamptz
            AND l.user_agent NOT LIKE 'Liekan-Crawler-Check/%' AND r.crawler_configuration IS NOT NULL
            AND lower(e.measurement->>'host')=$2
            AND e.measurement->>'hostBasis' IN('request_host','configured_host','declared_host')
          ORDER BY l.created_at LIMIT 1`,
    websiteId,
    hostname,
    timezone,
    new Date(endAt),
  );
  return earliest?.day as string | undefined;
}
