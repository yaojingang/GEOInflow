import {
  GEO_CONTENT_TYPES,
  GEO_METADATA_PATH,
  GEO_NON_CONTENT_EXTENSION,
  GEO_SCOPE,
} from '../geo-weight/policy';
import { factTable, identifier } from '../warehouse/catalog';
import { warehouseTime } from '../warehouse/fact-input';
import { factRelation } from '../warehouse/read';
import { effectiveLogRelation } from '../warehouse/reporting-relations';
import type { AiTx } from './ai-db';
import { warehouseReportQuery, withinWarehouseReport } from './warehouse-report-snapshot';

type Window = { asOf: string; startAt: number; endAt: number };
const js = (v: string, ...keys: string[]) =>
  `JSONExtract(${v},${keys.map(k => `'${k}'`).join(',')},'Nullable(String)')`;
const jb = (v: string, key: string) => `JSONExtract(${v},'${key}','Nullable(Bool)')`;
const logs = () =>
  effectiveLogRelation({
    immutableTimeWindow: { start: 'geoStart', end: 'geoEnd', endExclusive: true },
  });
const raw = () => `(SELECT ${factTable('liekan_log')
  .columns.map(c => `l.${identifier(c.name)} AS ${identifier(c.name)}`)
  .join(
    ',',
  )},e.crawler_id AS crawler_id,e.catalog_version AS catalog_version,e.classification_version AS classification_version,
  coalesce(e.measurement,'{}') AS measurement,coalesce(e.identity_evidence,'{}') AS identity_evidence,coalesce(e.edge_observation,'{}') AS edge_observation
  FROM ${logs()} l LEFT JOIN ${factRelation('liekan_crawler_evidence')} e ON e.website_id=l.website_id AND e.log_id=l.id)`;
async function metadata(tx: AiTx, site: string, range: Record<string, unknown>) {
  // Only catalog/rule-version identifiers cross to PG; paths and log IDs remain in CH.
  const versions = await warehouseReportQuery<{ catalogs: string[]; verifications: string[] }>(
    site,
    `SELECT groupUniqArray(catalog_version) AS catalogs,groupUniqArray(verification_version) AS verifications FROM ${raw()}`,
    range,
  );
  const catalogs = await tx.query<{ version: string; payload: any }>(
    'SELECT version::text,payload FROM liekan_crawler_registry_version WHERE version=ANY($1::uuid[])',
    versions[0].catalogs,
  );
  const rules = await tx.query(
    'SELECT version,catalog_version::text FROM liekan_crawler_rule_version WHERE website_id=$1::uuid AND crawler_configuration IS NOT NULL',
    site,
  );
  const bindings = await tx.query(
    `SELECT DISTINCT c.version::text AS catalog_version,rs.version AS verification_version,ids.id AS crawler_id
    FROM liekan_crawler_registry_version c CROSS JOIN LATERAL jsonb_array_elements(c.payload->'rangeSources') s(source)
    JOIN liekan_crawler_range_snapshot rs ON rs.source_id=s.source->>'id' AND rs.source_url=s.source->>'url'
    CROSS JOIN LATERAL jsonb_array_elements_text(rs.crawler_ids) ids(id)
    WHERE c.version=ANY($1::uuid[]) AND rs.version=ANY($2::text[]) AND s.source->'crawlerIds' ? ids.id AND s.source->>'enabled' IS DISTINCT FROM 'false'`,
    versions[0].catalogs,
    versions[0].verifications,
  );
  return {
    geoCatalogs: catalogs.map(c => c.version),
    geoIdentities: catalogs.flatMap(c =>
      (c.payload.identities ?? []).map((identity: any) =>
        JSON.stringify({
          version: c.version,
          identity: Object.fromEntries(
            ['id', 'purpose', 'platformId', 'kind', 'status', 'aiEligible', 'productForm']
              .map(k => [k, identity[k]])
              .concat([['metadata', { evidence: identity.metadata?.evidence }]]),
          ),
        }),
      ),
    ),
    geoRules: rules.map(r => JSON.stringify(r)),
    geoBindings: bindings.map(r => JSON.stringify(r)),
    geoPolicy: GEO_SCOPE.map(x => JSON.stringify(x)),
    geoMime: GEO_CONTENT_TYPES,
    geoMetadataPattern: `(?i)${GEO_METADATA_PATH}`,
    geoStaticPattern: `(?i)${GEO_NON_CONTENT_EXTENSION}`,
  };
}
const controls = `identities AS (SELECT JSONExtractString(j,'version') AS version,JSONExtractRaw(j,'identity') AS identity,JSONExtractString(j,'identity','id') AS id FROM (SELECT arrayJoin({geoIdentities:Array(String)}) AS j)),
  rules AS (SELECT JSONExtractString(j,'version') AS version,JSONExtractString(j,'catalog_version') AS catalog_version FROM (SELECT arrayJoin({geoRules:Array(String)}) AS j)),
  bindings AS (SELECT JSONExtractString(j,'catalog_version') AS catalog_version,JSONExtractString(j,'verification_version') AS verification_version,JSONExtractString(j,'crawler_id') AS crawler_id FROM (SELECT arrayJoin({geoBindings:Array(String)}) AS j)),
  policy AS (SELECT JSONExtractString(j,'id') AS id,JSONExtractString(j,'purpose') AS purpose,JSONExtractString(j,'platformId') AS platformId FROM (SELECT arrayJoin({geoPolicy:Array(String)}) AS j))`;
function evaluated() {
  const host = js('r.measurement', 'host'),
    basis = js('r.measurement', 'hostBasis'),
    mime = js('r.edge_observation', 'fields', 'EdgeResponseContentType', 'value'),
    mimeState = js('r.edge_observation', 'fields', 'EdgeResponseContentType', 'state');
  const form = js('i.identity', 'productForm'),
    conflict = `${js('r.identity_evidence', 'reason')}='identity_conflict'`;
  const history = `(has({geoCatalogs:Array(String)},toString(r.catalog_version)) AND coalesce(rv.version,'')=r.classification_version)`;
  return `(SELECT r.created_at AS created_at,r.path AS path,r.status AS status,r.source_id AS source_id,r.ai_eligible AS ai_eligible,
    r.recognition_state AS recognition_state,r.verification AS verification,r.verification_version AS verification_version,
    r.crawler_id AS crawler_id,r.catalog_version AS catalog_version,r.classification_version AS classification_version,
    r.user_agent LIKE 'Liekan-Crawler-Check/%' AS self_check,${mimeState} AS mime_state,
    ${host}={geoHostname:String} AS host_matches,coalesce(${basis},'')<>'request_host' AS inferred_host,
    (coalesce(${js('r.measurement', 'samplingTimeBasis')},'')<>'event_time' OR coalesce(${js('r.measurement', 'samplingBasis')},'')<>'observed_provider_config'
      OR coalesce(JSONExtract(r.measurement,'samplingRate','Nullable(Float64)'),-1)<>1) AS sampling_unknown,
    ${conflict} AS identity_conflict,p.purpose AS purpose,p.platformId AS platformId,${form} AS form,${history} AS history_available,
    multiIf(self_check,'self_check',isNull(${host}) OR lowerUTF8(${host})<>{geoHostname:String} OR coalesce(${basis},'') NOT IN('request_host','configured_host','declared_host'),'host',
      r.recognition_state='ambiguous' OR ${conflict},'ambiguous',isNull(p.id),'outside_scope',isNull(i.version) OR NOT ${history},'history',
      coalesce(r.recognition_state,'')<>'recognized' OR NOT coalesce(r.ai_eligible,false) OR coalesce(${js('i.identity', 'status')},'')<>'active'
        OR coalesce(${js('i.identity', 'kind')},'')<>'http_crawler' OR NOT coalesce(${jb('i.identity', 'aiEligible')},false)
        OR coalesce(${js('i.identity', 'metadata', 'evidence')},'')<>'operator' OR coalesce(${js('i.identity', 'purpose')},'')<>p.purpose
        OR coalesce(${js('i.identity', 'platformId')},'')<>p.platformId,'semantics',
      coalesce(r.verification,'')<>'verified_range' OR coalesce(r.verification_reason,'')<>'verified_range' OR isNull(r.verification_observed_at)
        OR abs(toUnixTimestamp64Micro(r.created_at)-toUnixTimestamp64Micro(r.verification_observed_at))>604800000000 OR isNull(rb.verification_version),'verification',
      r.method<>'GET' OR r.status NOT IN(200,304),'response',
      match(r.path,{geoMetadataPattern:String}) OR ${mimeState}='invalid' OR (${mimeState}='present' AND NOT has({geoMime:Array(String)},coalesce(${mime},'')))
        OR (coalesce(${mimeState},'unknown')<>'present' AND match(r.path,{geoStaticPattern:String})),'content',NULL) AS exclusion
    FROM ${raw()} r LEFT JOIN rules rv ON rv.version=r.classification_version AND rv.catalog_version=toString(r.catalog_version)
    LEFT JOIN identities i ON i.version=toString(r.catalog_version) AND i.id=r.crawler_id
    LEFT JOIN policy p ON p.id=r.crawler_id
    LEFT JOIN bindings rb ON rb.catalog_version=toString(r.catalog_version) AND rb.verification_version=r.verification_version AND rb.crawler_id=r.crawler_id)`;
}
function numbers(row: any, keys: string[]) {
  const out: any = {};
  for (const key of keys) {
    const n = Number(row[key]);
    if (!Number.isSafeInteger(n)) throw new Error('warehouse-counter-out-of-range');
    out[key] = n;
  }
  return out;
}
export async function warehouseGeoWeightAggregate(
  tx: AiTx,
  site: string,
  hostname: string,
  timezone: string,
  windows: Window[],
) {
  if (!windows.length) return [];
  return withinWarehouseReport(async () => {
    const range = {
      geoStart: warehouseTime(new Date(Math.min(...windows.map(w => w.startAt)))),
      geoEnd: warehouseTime(new Date(Math.max(...windows.map(w => w.endAt)))),
    };
    const control = await metadata(tx, site, range);
    const rows = await warehouseReportQuery<any>(
      site,
      `WITH ${controls},
      windows AS (SELECT w.1 AS asOf,parseDateTime64BestEffort(w.2,6,'UTC') AS startAt,parseDateTime64BestEffort(w.3,6,'UTC') AS endAt FROM
        (SELECT arrayJoin(arrayZip({geoDates:Array(String)},{geoStarts:Array(String)},{geoEnds:Array(String)})) AS w)),
      scoped AS (SELECT e.*,w.asOf AS asOf,toDate(e.created_at,{geoTimezone:String}) AS day FROM ${evaluated()} e INNER JOIN windows w ON e.created_at>=w.startAt AND e.created_at<w.endAt),
      grouped AS (SELECT *,arrayJoin(['stats','factor','operator','exclusion','identity','form']) AS kind FROM scoped)
      SELECT asOf,kind,
        multiIf(kind IN('factor','operator'),coalesce(purpose,''),kind='exclusion',coalesce(exclusion,''),kind='identity',coalesce(crawler_id,''),kind='form',coalesce(form,''),'') AS key1,
        multiIf(kind='operator',coalesce(platformId,''),kind='identity',coalesce(exclusion,''),'') AS key2,
        count() AS requests,countIf(isNull(exclusion)) AS accepted,countIf(verification='verified_range' AND recognition_state='recognized') AS verified,
        uniqExactIf(tuple(platformId,path,day),kind IN('factor','operator')) AS units,
        uniqExactIf(path,kind='factor') AS paths,uniqExactIf(day,kind IN('factor','operator')) AS days,
        countIf(isNull(exclusion) AND status=200) AS status200,countIf(isNull(exclusion) AND status=304) AS status304,
        countIf(isNull(exclusion) AND mime_state='present') AS mimeConfirmed,countIf(isNull(exclusion) AND coalesce(mime_state,'unknown')<>'present') AS pathInferred,
        countIf(NOT self_check AND inferred_host) AS inferredHost,countIf(NOT self_check AND sampling_unknown) AS samplingUnknown,
        countIf(NOT self_check AND (NOT history_available OR exclusion='history')) AS historyMissing,
        countIf(NOT self_check AND (exclusion IN('ambiguous','history','semantics','verification') OR (coalesce(recognition_state,'')<>'recognized' AND coalesce(ai_eligible,true)))) AS identityMissing,
        if(countIf(history_available AND NOT self_check AND host_matches)>0,toString(minIf(day,history_available AND NOT self_check AND host_matches)),NULL) AS firstEvidenceDay,
        arraySort(groupUniqArrayIf(toString(catalog_version),NOT self_check)) AS catalogVersions,
        arraySort(groupUniqArrayIf(classification_version,NOT self_check)) AS classificationVersions,
        arraySort(groupUniqArrayIf(verification_version,NOT self_check)) AS verificationVersions,
        arraySort(groupUniqArrayIf(coalesce(toString(source_id),'manual'),NOT self_check)) AS sources
      FROM grouped WHERE kind='stats' OR (kind IN('factor','operator') AND isNull(exclusion)) OR (kind='exclusion' AND isNotNull(exclusion))
        OR (kind='identity' AND isNotNull(crawler_id) AND NOT self_check) OR (kind='form' AND form IN('workbench','personal_agent') AND history_available
          AND NOT self_check AND coalesce(exclusion,'')<>'host' AND recognition_state='recognized' AND NOT coalesce(identity_conflict,false))
      GROUP BY asOf,kind,key1,key2 ORDER BY asOf,kind,key1,key2`,
      {
        ...range,
        ...control,
        geoHostname: hostname,
        geoTimezone: timezone,
        geoDates: windows.map(w => w.asOf),
        geoStarts: windows.map(w => warehouseTime(new Date(w.startAt))),
        geoEnds: windows.map(w => warehouseTime(new Date(w.endAt))),
      },
    );
    return windows.map(w => {
      const all = rows.filter(r => r.asOf === w.asOf),
        stats = all.find(r => r.kind === 'stats'),
        operators = all
          .filter(r => r.kind === 'operator')
          .map(r => ({ purpose: r.key1, platformId: r.key2, ...numbers(r, ['units', 'days']) }));
      const factors = all
        .filter(r => r.kind === 'factor')
        .map(r => ({
          purpose: r.key1,
          ...numbers(r, ['paths', 'units', 'days']),
          operators: operators.filter(o => o.purpose === r.key1 && o.units >= 10 && o.days >= 3)
            .length,
        }));
      const identities = new Map<string, any>();
      for (const row of all.filter(r => r.kind === 'identity')) {
        const current = identities.get(row.key1) ?? {
          id: row.key1,
          requests: 0,
          verified: 0,
          accepted: 0,
          exclusions: {},
        };
        for (const k of ['requests', 'verified', 'accepted']) current[k] += numbers(row, [k])[k];
        if (row.key2) current.exclusions[row.key2] = numbers(row, ['requests']).requests;
        identities.set(row.key1, current);
      }
      return {
        asOf: w.asOf,
        stats: stats
          ? {
              ...numbers(stats, [
                'requests',
                'accepted',
                'status200',
                'status304',
                'mimeConfirmed',
                'pathInferred',
                'inferredHost',
                'samplingUnknown',
                'historyMissing',
                'identityMissing',
              ]),
              firstEvidenceDay: stats.firstEvidenceDay,
              catalogVersions: stats.catalogVersions,
              classificationVersions: stats.classificationVersions,
              verificationVersions: stats.verificationVersions,
              sources: stats.sources,
            }
          : null,
        factors,
        operators,
        exclusions: Object.fromEntries(
          all
            .filter(r => r.kind === 'exclusion')
            .map(r => [r.key1, numbers(r, ['requests']).requests]),
        ),
        identities: [...identities.values()],
        forms: all
          .filter(r => r.kind === 'form')
          .map(r => ({ form: r.key1, ...numbers(r, ['requests']) })),
      };
    });
  });
}
export async function warehouseGeoWeightFirstEvidence(
  tx: AiTx,
  site: string,
  hostname: string,
  timezone: string,
  endAt: number,
) {
  return withinWarehouseReport(async () => {
    const range = {
        geoStart: '1900-01-01 00:00:00.000000',
        geoEnd: warehouseTime(new Date(endAt)),
      },
      control = await metadata(tx, site, range);
    const [row] = await warehouseReportQuery<{ day: string | null }>(
      site,
      `WITH ${controls}
      SELECT if(count()>0,toString(toDate(min(r.created_at),{geoTimezone:String})),NULL) AS day FROM ${raw()} r
      INNER JOIN rules rv ON rv.version=r.classification_version AND rv.catalog_version=toString(r.catalog_version)
      WHERE has({geoCatalogs:Array(String)},toString(r.catalog_version)) AND r.user_agent NOT LIKE 'Liekan-Crawler-Check/%'
        AND lowerUTF8(${js('r.measurement', 'host')})={geoHostname:String}
        AND ${js('r.measurement', 'hostBasis')} IN('request_host','configured_host','declared_host')`,
      { ...range, ...control, geoHostname: hostname, geoTimezone: timezone },
    );
    return row?.day ?? undefined;
  });
}

export async function warehouseCrawlerWindowVersions(
  site: string,
  start: number,
  end: number,
  source?: string,
) {
  const [r] = await warehouseReportQuery<any>(
    site,
    `SELECT uniqExact(coalesce(e.classification_version,'legacy')) AS classes,
    min(e.classification_version) AS classification,uniqExact(coalesce(toString(l.source_id),'manual')) AS sources,
    min(toString(l.source_id)) AS source,countIf(isNull(e.classification_version)) AS legacy
    FROM ${effectiveLogRelation({
      immutableTimeWindow: { start: 'geoStart', end: 'geoEnd', endExclusive: true },
      columns: ['website_id', 'id', 'created_at', 'source_id', 'user_agent'],
    })} l LEFT JOIN ${factRelation('liekan_crawler_evidence', {
      columns: ['website_id', 'log_id', 'classification_version'],
    })} e ON e.website_id=l.website_id AND e.log_id=l.id
    WHERE l.user_agent NOT LIKE 'Liekan-Crawler-Check/%'
      AND ({geoSource:Nullable(UUID)} IS NULL OR l.source_id={geoSource:Nullable(UUID)})`,
    {
      geoStart: warehouseTime(new Date(start)),
      geoEnd: warehouseTime(new Date(end)),
      geoSource: source ?? null,
    },
  );
  return { ...r, ...numbers(r, ['classes', 'sources', 'legacy']) };
}
