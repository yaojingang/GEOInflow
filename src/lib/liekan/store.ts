import { collectionRepairScope } from './upstream/history-repair-boundary';
import { getPublishedCatalog } from './crawlers/published';
import { withPublishedRegistry } from './upstream/crawler-registry-context';
import { parseLogInputWithGeography, persistLogGeography } from './upstream/log-geography';
import { invalidateWebsiteAnalytics } from './upstream/query-cache';
import { bumpAnalyticsRevision } from './upstream/analytics-revision';
import { syncLegacyRobotsDraft } from './upstream/robots-draft';
import { randomUUID } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { parseCatalog, parseLogInput } from './ingest';
import { verificationSnapshots } from './log-ingestion/ranges';
import {
  crawlerClassificationVersion,
  crawlerIdentityId,
  archiveCrawlerRules,
  persistCrawlerEvidence,
} from './log-ingestion/crawler-evidence';
import { BOT_TYPES, type BotRule } from './rules/bots';
import {
  resolveCrawlerRules,
  preserveHistoricalRules,
  validateCrawlerConfiguration,
  type CrawlerRuleConfiguration,
} from './rules/configuration';
import {
  LiekanError,
  lockWritableWebsite,
  query,
  transaction,
  type WriteIdentity,
} from './upstream/server';

const settingsQuery = `SELECT s.robots,s.allowlist,s.rules,s.crawler_rules AS "crawlerRules",s.rules_revision AS "rulesRevision",s.is_demo AS "isDemo",s.ai_crawler_enabled AS "aiCrawlerEnabled",
    (EXISTS (SELECT 1 FROM liekan_log_source WHERE website_id=$1::uuid AND state='active')
      OR EXISTS (SELECT 1 FROM liekan_import WHERE website_id=$1::uuid AND accepted>0
        AND (kind='automatic' OR NOT COALESCE(s.is_demo,false)))) AS "logsConfigured"
    FROM (SELECT $1::uuid AS website_id) w LEFT JOIN liekan_setting s USING (website_id)`;
function settingsFromRow(row?: {
  robots?: string;
  allowlist?: string[];
  rules?: BotRule[];
  crawlerRules?: CrawlerRuleConfiguration;
  rulesRevision?: number;
  isDemo?: boolean;
  aiCrawlerEnabled?: boolean;
  logsConfigured?: boolean;
}) {
  const resolved = resolveCrawlerRules(row);
  return {
    robots: row?.robots ?? '',
    allowlist: row?.allowlist ?? [],
    rules: resolved.rules,
    crawlerRules: resolved.configuration,
    rulesRevision: Number(row?.rulesRevision ?? 0),
    classificationVersion: crawlerClassificationVersion(resolved.rules, resolved.configuration),
    isDemo: row?.isDemo ?? false,
    aiCrawlerEnabled: row?.aiCrawlerEnabled ?? true,
    logsConfigured: row?.logsConfigured ?? false,
  };
}
export async function getSettings(id: string, tx?: any) {
  return settingsFromRow(
    (await (tx ? tx.$queryRawUnsafe(settingsQuery, id) : query(settingsQuery, id)))[0],
  );
}
export async function saveSettings(id: string, body: any, identity?: WriteIdentity) {
  id = id.toLowerCase();
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !Object.keys(body).length ||
    Object.keys(body).some(
      key =>
        ![
          'robots',
          'allowlist',
          'rules',
          'aiCrawlerEnabled',
          'crawlerRules',
          'expectedRulesRevision',
          'conversionConfirmed',
        ].includes(key),
    )
  )
    throw new LiekanError('设置格式无效');
  const has = (key: string) => Object.hasOwn(body, key);
  if (has('rules') && has('crawlerRules')) throw new LiekanError('不能同时提交两种规则配置');
  if (
    has('expectedRulesRevision') &&
    (!Number.isSafeInteger(body.expectedRulesRevision) || body.expectedRulesRevision < 0)
  )
    throw new LiekanError('规则版本无效');
  if (has('conversionConfirmed') && typeof body.conversionConfirmed !== 'boolean')
    throw new LiekanError('规则确认无效');
  let requestedConfiguration: CrawlerRuleConfiguration | undefined;
  if (has('crawlerRules')) {
    if (!has('expectedRulesRevision')) throw new LiekanError('请刷新规则版本');
    try {
      requestedConfiguration = validateCrawlerConfiguration(body.crawlerRules);
    } catch {
      throw new LiekanError('蜘蛛规则配置无效');
    }
  }
  if (has('aiCrawlerEnabled') && typeof body.aiCrawlerEnabled !== 'boolean')
    throw new LiekanError('AI 蜘蛛展示设置必须为布尔值');
  if (has('robots') && (typeof body.robots !== 'string' || body.robots.length > 50000))
    throw new LiekanError('设置格式无效');
  if (has('allowlist')) {
    if (!Array.isArray(body.allowlist) || body.allowlist.length > 100)
      throw new LiekanError('设置格式无效');
    for (const ip of body.allowlist) {
      try {
        if (typeof ip !== 'string' || ip.length > 80) throw new Error('Invalid CIDR');
        ipaddr.parseCIDR(ip);
      } catch {
        throw new LiekanError('白名单必须是合法 CIDR');
      }
    }
  }
  if (has('rules')) {
    if (!Array.isArray(body.rules) || body.rules.length > 100)
      throw new LiekanError('设置格式无效');
    for (const rule of body.rules)
      if (
        !rule ||
        typeof rule !== 'object' ||
        !['name', 'vendor', 'type', 'pattern'].every(
          key => typeof rule[key] === 'string' && rule[key].length > 0 && rule[key].length <= 80,
        )
      )
        throw new LiekanError('规则需要 name、vendor、type、pattern 字段，长度上限 80');
    if (body.rules.some(rule => !BOT_TYPES.includes(rule.type)))
      throw new LiekanError('规则类型仅支持训练、搜索、用户触发、传统搜索和其他');
    // Legacy clients may send display metadata; it never establishes an official identity.
    requestedConfiguration = body.rules.length
      ? {
          mode: 'legacy',
          rules: body.rules.map(rule => ({
            name: rule.name,
            vendor: rule.vendor,
            type: rule.type,
            pattern: rule.pattern,
            matchMode: rule.matchMode === 'token' ? 'token' : 'literal',
          })),
        }
      : { mode: 'disabled' };
  }
  const result = await transaction(async tx => {
    await lockWritableWebsite(tx, id, identity);
    if (has('robots')) await syncLegacyRobotsDraft(tx, id, body.robots);
    const current = settingsFromRow((await tx.$queryRawUnsafe(settingsQuery, id))[0]);
    if (has('expectedRulesRevision') && body.expectedRulesRevision !== current.rulesRevision)
      throw new LiekanError('规则已被更新，请刷新后重试', 409);
    if (
      has('crawlerRules') &&
      current.crawlerRules.mode !== 'official' &&
      requestedConfiguration.mode === 'official' &&
      body.conversionConfirmed !== true
    )
      throw new LiekanError('请预览并确认规则转换', 409);
    const configuration = requestedConfiguration
      ? preserveHistoricalRules(
          requestedConfiguration,
          body.crawlerRules?.mode === 'legacy' ? body.crawlerRules.rules : body.rules,
          current.crawlerRules,
        )
      : current.crawlerRules;
    const resolved = resolveCrawlerRules({ crawlerRules: configuration });
    const rulesRevision = current.rulesRevision + (requestedConfiguration ? 1 : 0);
    const next = {
      robots: has('robots') ? body.robots : current.robots,
      allowlist: has('allowlist') ? body.allowlist : current.allowlist,
      rules: resolved.rules,
      crawlerRules: configuration,
      rulesRevision,
      classificationVersion: crawlerClassificationVersion(resolved.rules, configuration),
      aiCrawlerEnabled: has('aiCrawlerEnabled') ? body.aiCrawlerEnabled : current.aiCrawlerEnabled,
    };
    await tx.$executeRawUnsafe(
      'INSERT INTO liekan_setting(website_id,robots,allowlist,rules,ai_crawler_enabled,crawler_rules,rules_revision) VALUES ($1::uuid,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb,$7) ON CONFLICT(website_id) DO UPDATE SET robots=$2,allowlist=$3::jsonb,rules=$4::jsonb,ai_crawler_enabled=$5,crawler_rules=$6::jsonb,rules_revision=$7,updated_at=now()',
      id,
      next.robots,
      JSON.stringify(next.allowlist),
      configuration.mode === 'official' ? null : JSON.stringify(next.rules),
      next.aiCrawlerEnabled,
      JSON.stringify(configuration),
      rulesRevision,
    );
    await archiveCrawlerRules(tx, id, resolved.rules, configuration);
    await tx.$executeRawUnsafe(
      'INSERT INTO liekan_log_state(website_id,data_revision) VALUES ($1::uuid,1) ON CONFLICT(website_id) DO UPDATE SET data_revision=liekan_log_state.data_revision+1,updated_at=now()',
      id,
    );
    await bumpAnalyticsRevision(tx, 'website', id);
    return { ...next, isDemo: current.isDemo, logsConfigured: current.logsConfigured };
  });
  invalidateWebsiteAnalytics(id);
  return result;
}
export async function importLogs(id: string, domain: string, input: any, identity?: WriteIdentity) {
  return withPublishedRegistry(() => importPinnedLogs(id, domain, input, identity));
}
async function importPinnedLogs(id: string, domain: string, input: any, identity?: WriteIdentity) {
  id = id.toLowerCase();
  const settings = await getSettings(id);
  const classificationVersion = settings.classificationVersion;
  let parsed: ReturnType<typeof parseLogInput>;
  try {
    parsed = await parseLogInputWithGeography(
      input,
      domain,
      process.env.APP_SECRET ||
        (() => {
          throw new LiekanError('缺少 APP_SECRET，无法保护来源标识');
        })(),
      settings.rules as BotRule[],
      await verificationSnapshots(),
    );
  } catch (error) {
    throw new LiekanError((error as Error).message);
  }
  if (!parsed.records.length)
    throw new LiekanError('没有有效日志；请检查时间、IP、路径、状态和 User-Agent');
  const result = await transaction(async tx => {
    // One importing transaction per website, including across replicas/processes.
    const lock = await tx.$queryRawUnsafe(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
      `liekan-import:${id}`,
    );
    if (!lock[0].acquired) throw new LiekanError('该站点已有导入正在处理', 409);
    await lockWritableWebsite(tx, id, identity);
    if ((await getSettings(id, tx)).classificationVersion !== classificationVersion)
      throw new LiekanError('规则已被更新，请重新提交日志', 409);
    await archiveCrawlerRules(tx, id, settings.rules, settings.crawlerRules);
    const old = await tx.$queryRawUnsafe(
      'SELECT id,accepted,rejected FROM liekan_import WHERE website_id=$1::uuid AND digest=$2',
      id,
      parsed.digest,
    );
    if (old.length) return { ...old[0], duplicate: true, inserted: 0, errors: parsed.errors };
    const rate = await tx.$queryRawUnsafe(
      "SELECT count(*)::int AS count FROM liekan_import WHERE website_id=$1::uuid AND kind='manual' AND imported_at>now()-interval '1 minute'",
      id,
    );
    if (rate[0].count >= 5) throw new LiekanError('每站点每分钟上限 5 次导入', 429);
    const intervals = await tx.$queryRawUnsafe(
      'SELECT starts_at,ends_at FROM liekan_log_interval WHERE website_id=$1::uuid',
      id,
    );
    const allowed = parsed.records.filter((record, index) => {
      const time = +new Date(record.time);
      if (
        !intervals.some(
          row =>
            time >= +new Date(row.starts_at) && (!row.ends_at || time < +new Date(row.ends_at)),
        )
      )
        return true;
      parsed.errors.push({ line: parsed.validLines[index], reason: '时间范围与自动日志来源重叠' });
      return false;
    });
    parsed.errors = parsed.errors.slice(0, 100);
    parsed.rejected += parsed.records.length - allowed.length;
    parsed.records = allowed;
    parsed.accepted = allowed.length;
    if (!allowed.length) throw new LiekanError('日志时间范围与自动来源重叠，请导入其他时间段', 409);
    const importId = randomUUID();
    await tx.$executeRawUnsafe(
      'INSERT INTO liekan_import (id,website_id,digest,accepted,rejected,repair_scope_id) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::uuid)',
      importId,
      id,
      parsed.digest,
      parsed.accepted,
      parsed.rejected,
      await collectionRepairScope(tx,id),
    );
    let inserted = 0;
    for (let offset = 0; offset < parsed.records.length; offset += 500) {
      inserted += await tx.$executeRawUnsafe(
        `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,verification_version,ai_eligible,recognition_state,recognition_candidates,verification_observed_at,verification_reason)
        SELECT r.id,$1::uuid,$2::uuid,r.time::timestamptz,r.path,r.method,r.status,r.bytes,r."ipMasked",r."ipHash",r."userAgent",r.location,r.bot,r.vendor,r.type,r.verification,r."verificationVersion",r."aiEligible",r."recognitionState",r."recognitionCandidates",r."verificationObservedAt"::timestamptz,r."verificationReason"
        FROM jsonb_to_recordset($3::jsonb) AS r(id text,time text,path text,method text,status integer,bytes bigint,"ipMasked" text,"ipHash" text,"userAgent" text,location text,bot text,vendor text,type text,verification text,"verificationVersion" text,"aiEligible" boolean,"recognitionState" text,"recognitionCandidates" jsonb,"verificationObservedAt" text,"verificationReason" text)
        ON CONFLICT(website_id,id) DO NOTHING`,
        id,
        importId,
        JSON.stringify(parsed.records.slice(offset, offset + 500)),
      );
      await persistLogGeography(tx, id, parsed.records.slice(offset, offset + 500));
      await persistCrawlerEvidence(
        tx,
        id,
        importId,
        parsed.records.slice(offset, offset + 500).map(row => ({
          id: row.id,
          measurement: row.measurement,
          classificationVersion,
          catalogVersion: getPublishedCatalog()?.version ?? null,
          crawlerId: crawlerIdentityId(row.userAgent, settings.rules),
        })),
      );
    }
    await tx.$executeRawUnsafe(
      'INSERT INTO liekan_log_state(website_id,data_revision) VALUES ($1::uuid,1) ON CONFLICT(website_id) DO UPDATE SET data_revision=liekan_log_state.data_revision+1',
      id,
    );
    return {
      id: importId,
      accepted: parsed.accepted,
      rejected: parsed.rejected,
      inserted,
      duplicate: false,
      errors: parsed.errors,
    };
  });
  invalidateWebsiteAnalytics(id);
  return result;
}
export async function importCatalog(
  id: string,
  domain: string,
  input: any,
  identity?: WriteIdentity,
) {
  id = id.toLowerCase();
  let rows: ReturnType<typeof parseCatalog>;
  try {
    rows = parseCatalog(input, domain);
  } catch (error) {
    throw new LiekanError((error as Error).message);
  }
  if (!rows.length) throw new LiekanError('内容目录为空');
  const columns: Record<string, string> = {
    title: 'title',
    type: 'content_type',
    wordCount: 'word_count',
    publishedAt: 'published_at',
    structured: 'structured',
    structureScore: 'structure_score',
    updatedAt: 'content_updated_at',
    linkDepth: 'link_depth',
    source: 'evidence_source',
  };
  const groups = new Map<string, { rows: typeof rows; updates: string[] }>();
  for (const row of rows) {
    const provided = Object.keys(columns).filter(field => row.providedFields.includes(field));
    const key = provided.join(',');
    let group = groups.get(key);
    if (!group) {
      group = {
        rows: [],
        updates: provided.map(field => `${columns[field]}=EXCLUDED.${columns[field]}`),
      };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  await transaction(async tx => {
    await lockWritableWebsite(tx, id, identity);
    await tx.$executeRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      `liekan-catalog:${id}`,
    );
    for (const group of groups.values()) {
      const conflict = group.updates.length
        ? `DO UPDATE SET ${group.updates.join(',')},updated_at=now()`
        : 'DO NOTHING';
      for (let i = 0; i < group.rows.length; i += 500) {
        await tx.$executeRawUnsafe(
          `INSERT INTO liekan_catalog(website_id,path,title,content_type,word_count,published_at,structured,structure_score,content_updated_at,link_depth,evidence_source)
        SELECT $1::uuid,r.path,r.title,r.type,r."wordCount",r."publishedAt"::timestamptz,r.structured,r."structureScore",r."updatedAt"::timestamptz,r."linkDepth",r.source
        FROM jsonb_to_recordset($2::jsonb) AS r(path text,title text,type text,"wordCount" integer,"publishedAt" text,structured boolean,"structureScore" integer,"updatedAt" text,"linkDepth" integer,source text)
        ON CONFLICT(website_id,path) ${conflict}`,
          id,
          JSON.stringify(group.rows.slice(i, i + 500)),
        );
      }
    }
    await bumpAnalyticsRevision(tx, 'website', id);
  });
  invalidateWebsiteAnalytics(id);
  return { accepted: rows.length, mode: 'upsert' };
}
