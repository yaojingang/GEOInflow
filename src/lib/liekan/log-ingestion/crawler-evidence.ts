import type { RequestIdentityEvidence } from '../crawlers/request-verification';
import { getPublishedCatalog } from '../crawlers/published';
import { edgeObservation, type EdgeObservation } from './edge-observation';
import { logMeasurementSchema, type LogMeasurement } from './measurement';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BotRule } from '../rules/bots';
import type { CrawlerRuleConfiguration } from '../rules/configuration';
import { classifyBot, MATCHER_VERSION } from '../rules/bots';
import { crawlerIdForRule } from '../crawlers/directory';

const ruleId = z.string().regex(/^[a-f0-9]{32}$/i);
const evidenceSchema = z.object({
  securityAction: z
    .string()
    .max(64)
    .regex(/^[a-z_]+$/)
    .nullable(),
  terminatingRuleId: ruleId.nullable(),
  matchedRuleIds: z.array(ruleId).max(100).nullable(),
  cacheStatus: z
    .string()
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .nullable(),
  durationMs: z.number().min(0).max(600000).nullable(),
});
export type CrawlerLogEvidence = z.infer<typeof evidenceSchema> & {
  edgeObservation?: EdgeObservation;
};
function orderedConfiguration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedConfiguration);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, orderedConfiguration(value[key])]),
    );
  return value;
}
/** Include signed-identity settings; JSONB key order cannot change the effective version. */
export function crawlerClassificationVersion(
  rules: BotRule[],
  configuration?: CrawlerRuleConfiguration,
) {
  const ordered = rules.map(rule => ({
    name: rule.name,
    vendor: rule.vendor,
    type: rule.type,
    pattern: rule.pattern,
    matchMode: rule.matchMode ?? 'literal',
    crawlerId: crawlerIdForRule(rule),
    aiEligible: rule.aiEligible ?? ['训练', '搜索', '用户触发'].includes(rule.type),
  }));
  return createHash('sha256')
    .update(
      JSON.stringify({
        matcher: MATCHER_VERSION,
        catalog: getPublishedCatalog()?.version ?? null,
        rules: ordered,
        configuration:
          configuration &&
          orderedConfiguration(
            configuration.mode === 'official'
              ? { ...configuration, disabledIds: [...configuration.disabledIds].sort() }
              : configuration,
          ),
      }),
    )
    .digest('hex');
}
const archivedRuleVersions = new Set<string>();

export async function archiveCrawlerRules(
  tx: any,
  websiteId: string,
  rules: BotRule[],
  configuration?: CrawlerRuleConfiguration,
) {
  const version = crawlerClassificationVersion(rules, configuration);
  const cacheKey = `${websiteId}:${version}`;
  if (archivedRuleVersions.has(cacheKey)) return version;
  await tx.$executeRawUnsafe(
    `INSERT INTO liekan_crawler_rule_version(website_id,version,matcher_version,rules,catalog_version,crawler_configuration)
     VALUES($1::uuid,$2,$3,$4::jsonb,$5::uuid,$6::jsonb) ON CONFLICT(website_id,version) DO NOTHING`,
    websiteId,
    version,
    MATCHER_VERSION,
    JSON.stringify(rules),
    getPublishedCatalog()?.version ?? null,
    configuration ? JSON.stringify(configuration) : null,
  );
  if (archivedRuleVersions.size > 2000) archivedRuleVersions.clear();
  archivedRuleVersions.add(cacheKey);
  return version;
}
export function crawlerIdentityId(userAgent: string, rules: BotRule[]) {
  return crawlerIdForRule(classifyBot(userAgent, rules));
}
export function cloudflareCrawlerEvidence(raw: Record<string, unknown>): CrawlerLogEvidence | null {
  const optional = edgeObservation(raw);
  const values = {
    securityAction: raw.SecurityAction ?? null,
    terminatingRuleId: raw.SecurityRuleID || null,
    matchedRuleIds: raw.SecurityRuleIDs ?? null,
    cacheStatus: raw.CacheCacheStatus ?? null,
    durationMs: optional.fields.edgeDurationMs.value,
  };
  const parsed = Object.fromEntries(
    Object.entries(evidenceSchema.shape).map(([key, schema]) => {
      const result = schema.safeParse(values[key]);
      return [key, result.success ? result.data : null];
    }),
  ) as z.infer<typeof evidenceSchema>;
  return { ...parsed, edgeObservation: optional };
}
export async function persistCrawlerEvidence(
  tx: any,
  websiteId: string,
  importId: string,
  records: Array<{
    id: string;
    measurement?: LogMeasurement;
    classificationVersion?: string;
    catalogVersion?: string | null;
    identityEvidence?: RequestIdentityEvidence;
    crawlerId?: string | null;
    crawlerEvidence?: CrawlerLogEvidence | null;
  }>,
) {
  if (!records.length) return;
  const evidence = records.map(row => ({
    id: row.id,
    classificationVersion: row.classificationVersion ?? null,
    catalogVersion: row.catalogVersion ?? null,
    identityEvidence: row.identityEvidence ?? null,
    crawlerId: row.crawlerId ?? null,
    measurement: row.measurement ? logMeasurementSchema.parse(row.measurement) : null,
    ...(row.crawlerEvidence ?? {}),
  }));
  // The runtime site value avoids stale new-site MCV estimates selecting a
  // site-prefix scan per record. Check import ownership after the unique point lookup.
  await tx.$executeRawUnsafe(
    `INSERT INTO liekan_crawler_evidence(website_id,log_id,classification_version,crawler_id,security_action,terminating_rule_id,matched_rule_ids,cache_status,duration_ms,measurement,edge_observation,catalog_version,identity_evidence)
     SELECT $1::uuid,r.id,r."classificationVersion",r."crawlerId",r."securityAction",r."terminatingRuleId",r."matchedRuleIds",r."cacheStatus",r."durationMs",r.measurement,r."edgeObservation",r."catalogVersion",r."identityEvidence"
     FROM jsonb_to_recordset($3::jsonb) AS r(id text,"classificationVersion" text,"crawlerId" text,"securityAction" text,"terminatingRuleId" text,"matchedRuleIds" jsonb,"cacheStatus" text,"durationMs" double precision,measurement jsonb,"edgeObservation" jsonb,"catalogVersion" uuid,"identityEvidence" jsonb)
     JOIN LATERAL (SELECT import_id FROM liekan_log l
       WHERE l.website_id=(SELECT $1::uuid OFFSET 0) AND l.id=r.id OFFSET 0) l ON l.import_id=$2::uuid
     ON CONFLICT(website_id,log_id) DO NOTHING`,
    websiteId,
    importId,
    JSON.stringify(evidence),
  );
}
