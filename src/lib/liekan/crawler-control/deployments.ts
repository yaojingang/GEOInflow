import { warehouseEnabled } from '../warehouse/authority-routing';
import { withinWarehouseReport } from '../upstream/warehouse-report-snapshot';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  crawlerConfirmInputSchema,
  crawlerPreviewInputSchema,
  type CrawlerPolicyInput,
} from '../contracts/crawlers';
import { crawlerDirectory, getCrawler } from '../crawlers/directory';
import { buildCloudflareExpression, crawlerTemplateLimitations } from '../crawlers/templates';
import { crawlerTransaction, type CrawlerActor } from '../upstream/crawler-access';
import type { AiTx } from '../upstream/ai-db';
import { LiekanError } from '../upstream/errors';
import {
  CrawlerProviderError,
  crawlerDesiredMatches,
  crawlerRemoteHash,
  ownedCrawlerRule,
  readCrawlerCloudflare,
  writeCrawlerCloudflare,
  type CloudflareCrawlerRule,
  type CloudflareCrawlerSnapshot,
} from './cloudflare';
import {
  assertPolicyContext,
  assertPolicyRegistry,
  assertConnectionContext,
  authorizeCrawlerHandoff,
  controlConnection,
  controlContext,
  controlHash,
  controlId,
  controlPolicy,
  controlToken,
  deploymentDto,
  type ConnectionRow,
  type ControlContext,
  type DeploymentRow,
  type PolicyRow,
} from './control-store';
import { acquireCrawlerLease, releaseCrawlerLease } from './leases';

export const crawlerReconcileInput = z
  .strictObject({
    acknowledgeNotApplied: z.boolean().default(false),
    acknowledgeHandoff: z.boolean().optional(),
    connectionId: z.uuid().optional(),
  })
  .refine(
    input => !input.acknowledgeHandoff || !!input.connectionId,
    'Handoff reconciliation requires a current connection',
  );
export const crawlerHandoffReconcileInput = z.strictObject({
  deploymentId: z.uuid(),
  websiteId: z.uuid(),
  connectionId: z.uuid(),
  acknowledgeHandoff: z.literal(true),
  acknowledgeNotApplied: z.boolean().default(false),
});
export const crawlerAdoptPreviewInput = z.strictObject({});
interface TransferParty {
  connectionId: string;
  generation: number;
  ownerUserId: string | null;
  teamId: string | null;
}
interface Transfer {
  previous: TransferParty;
  next: TransferParty;
}

interface Target {
  mode?: 'apply' | 'adopt';
  transfer?: Transfer | null;
  body: CrawlerPolicyInput;
  version: number;
  ref: string;
  hostname: string;
  connectionId: string | null;
  localOnly: boolean;
  rule: CloudflareCrawlerRule | null;
  binding: {
    ownerUserId: string | null;
    teamId: string | null;
    credentialFingerprint: string | null;
    directoryHash: string;
    capabilityFingerprint: string | null;
  };
  before: { rule: CloudflareCrawlerRule | null; hash: string; rulesetId: string | null };
  capabilities: Record<string, boolean | number | string | null>;
}
interface PreviewRow {
  id: string;
  website_id: string;
  policy_id: string;
  connection_id: string | null;
  actor_id: string;
  generation: number;
  policy_version: number;
  operation: DeploymentRow['operation'];
  payload: Target;
  fingerprint: string;
  expires_at: Date;
}
const directoryHash = () =>
  controlHash(
    crawlerDirectory
      .filter(entry => entry.control.remote)
      .map(entry => ({
        id: entry.id,
        type: entry.type,
        kind: entry.kind,
        uaSelector: entry.uaSelector,
        control: entry.control,
      })),
  );
const pendingSql =
  "SELECT id FROM liekan_crawler_deployment WHERE policy_id=$1::uuid AND state IN('queued','running','unknown','cleanup') LIMIT 1";
function conflict(message = '策略、连接或远端规则已变化，请重新预览'): never {
  throw new LiekanError(message, 409);
}
function binding(context: ControlContext, connection: ConnectionRow | null): Target['binding'] {
  return {
    ownerUserId: context.website.ownerUserId,
    teamId: context.website.teamId,
    credentialFingerprint: connection ? controlHash(connection.token_encrypted) : null,
    directoryHash: directoryHash(),
    capabilityFingerprint: connection ? controlHash(connection.capabilities) : null,
  };
}
function controlExpression(host: string, body: CrawlerPolicyInput) {
  try {
    return buildCloudflareExpression(host, body);
  } catch {
    throw new LiekanError('策略表达式超出 2 KiB，请减少路径或蜘蛛数量', 400);
  }
}
async function targetBody(
  tx: AiTx,
  policy: PolicyRow,
  input: z.infer<typeof crawlerPreviewInputSchema>,
) {
  const version =
    input.operation === 'rollback'
      ? input.targetVersion
      : ['stop', 'cleanup'].includes(input.operation)
        ? (policy.applied_version ?? policy.version)
        : policy.version;
  if (!version) throw new LiekanError('回滚需要明确的历史版本', 400);
  const [row] = await tx.query<{ body: CrawlerPolicyInput }>(
    'SELECT body FROM liekan_crawler_policy_version WHERE policy_id=$1::uuid AND version=$2',
    policy.id,
    version,
  );
  if (!row) throw new LiekanError('目标策略版本不存在', 404);
  return { body: row.body, version };
}
function selectOwned(snapshot: CloudflareCrawlerSnapshot, policy: PolicyRow) {
  const rule = ownedCrawlerRule(snapshot, policy.ref);
  if (
    rule &&
    (!policy.remote_rule_id ||
      rule.id !== policy.remote_rule_id ||
      snapshot.rulesetId !== policy.remote_ruleset_id)
  )
    conflict('远端规则身份与已登记规则不一致，请人工核对');
  if (policy.remote_rule_id && !rule) conflict('已登记远端规则缺失，请人工核对');
  if (policy.remote_hash && crawlerRemoteHash(rule) !== policy.remote_hash)
    conflict('远端规则发生人工变化，请核对后重新建立策略');
  return rule;
}
function transferFor(
  context: ControlContext,
  policy: PolicyRow,
  old: ConnectionRow,
  next: ConnectionRow,
): Transfer {
  return {
    previous: {
      connectionId: old.id,
      generation: policy.generation,
      ownerUserId: old.owner_user_id,
      teamId: old.team_id,
    },
    next: {
      connectionId: next.id,
      generation: context.generation,
      ownerUserId: context.website.ownerUserId,
      teamId: context.website.teamId,
    },
  };
}
async function previousConnection(tx: AiTx, websiteId: string, policy: PolicyRow) {
  if (!policy.connection_id) conflict('策略没有可核对的远端连接登记');
  const [old] = await tx.query<ConnectionRow>(
    'SELECT * FROM liekan_crawler_connection WHERE id=$1::uuid AND website_id=$2::uuid FOR UPDATE',
    policy.connection_id,
    websiteId,
  );
  if (!old) conflict('原控制连接登记缺失');
  return old;
}
async function previewConnection(
  tx: AiTx,
  context: ControlContext,
  websiteId: string,
  policy: PolicyRow,
  cleanup: boolean,
) {
  if (!policy.connection_id)
    return { connection: await controlConnection(tx, context, websiteId), transfer: null };
  const old = await previousConnection(tx, websiteId, policy);
  if (old.state === 'active' || (cleanup && old.state === 'cleanup'))
    return {
      connection: await controlConnection(tx, context, websiteId, old.id, cleanup),
      transfer: null,
    };
  const connection = await controlConnection(tx, context, websiteId);
  if (
    old.domain !== context.host ||
    old.zone_id !== connection.zone_id ||
    old.owner_user_id !== context.website.ownerUserId ||
    old.team_id !== context.website.teamId
  )
    conflict('原策略归属已变化，请使用明确接管预览');
  return { connection, transfer: transferFor(context, policy, old, connection) };
}
async function validateTransfer(
  tx: AiTx,
  context: ControlContext,
  policy: PolicyRow,
  target: Target,
  connection: ConnectionRow,
) {
  const transfer = target.transfer;
  if (!transfer) conflict('接管上下文缺失');
  const old = await previousConnection(tx, policy.website_id, policy);
  if (
    old.domain !== context.host ||
    old.zone_id !== connection.zone_id ||
    controlHash(transferFor(context, policy, old, connection)) !== controlHash(transfer)
  )
    conflict('接管归属、域名或原 Zone 已变化，请重新预览');
}
async function historicalImpact(tx: AiTx, websiteId: string, body: CrawlerPolicyInput) {
  const [counts] = await tx.query<{ requests: number; unclassified: number; observed: number }>(
    `SELECT count(*) FILTER(WHERE e.crawler_id=ANY($2::text[]) AND EXISTS(
    SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS x(value text,match text) WHERE l.path=x.value OR
    (x.match='prefix' AND left(l.path,length(CASE WHEN right(x.value,1)='/' THEN x.value ELSE x.value||'/' END))=CASE WHEN right(x.value,1)='/' THEN x.value ELSE x.value||'/' END)
    ))::float8 AS requests,count(*) FILTER(WHERE e.crawler_id IS NULL)::float8 AS unclassified,count(*)::float8 AS observed
    FROM liekan_effective_log l LEFT JOIN liekan_crawler_evidence e ON e.website_id=l.website_id AND e.log_id=l.id
    WHERE l.website_id=$1::uuid AND l.created_at>=now()-interval '7 days' AND l.created_at<=now()`,
    websiteId,
    body.botIds,
    JSON.stringify(body.paths),
  );
  return {
    requests: counts?.observed ? counts.requests : null,
    observedRequests: counts?.observed ?? 0,
    state: !counts?.observed
      ? ('missing' as const)
      : counts.unclassified
        ? ('partial' as const)
        : ('available' as const),
    unclassified: counts?.unclassified ?? 0,
    basis: 'historical_estimate' as const,
    windowDays: 7,
  };
}
async function warehouseHistoricalImpact(websiteId: string, body: CrawlerPolicyInput) {
  return (await import('../upstream/warehouse-evidence-queries')).warehouseHistoricalImpact(
    websiteId,
    body,
  );
}
async function previewCrawlerPolicySnapshot(
  actor: CrawlerActor,
  websiteId: string,
  policyId: string,
  input: z.infer<typeof crawlerPreviewInputSchema>,
) {
  const data = crawlerPreviewInputSchema.parse(input);
  const prepared = await crawlerTransaction(async tx => {
    let context = await controlContext(tx, actor, websiteId, 'draft');
    const policy = await controlPolicy(tx, websiteId, policyId);
    assertPolicyContext(context, policy);
    if ((await tx.query(pendingSql, policy.id)).length) conflict('请先完成或核对当前操作');
    const selected = await targetBody(tx, policy, data);
    if (
      ['deploy', 'rollback'].includes(data.operation) &&
      selected.body.action === 'observe' &&
      policy.remote_rule_id
    )
      conflict('请先确认清理已登记的远端规则，再启用本地观察');
    const localOnly =
      (selected.body.action === 'observe' && !policy.remote_rule_id) ||
      (['stop', 'cleanup'].includes(data.operation) &&
        !policy.connection_id &&
        !policy.remote_rule_id);
    let connection: ConnectionRow | null = null,
      transfer: Transfer | null = null;
    if (!localOnly) {
      context = await controlContext(tx, actor, websiteId, 'control');
      const chosen = await previewConnection(
        tx,
        context,
        websiteId,
        policy,
        data.operation === 'cleanup',
      );
      connection = chosen.connection;
      transfer = chosen.transfer;
    }
    return { context, policy, selected, localOnly, connection, transfer };
  });
  const snapshot = prepared.connection
    ? await readCrawlerCloudflare(
        controlToken(prepared.connection),
        prepared.connection.zone_id,
        prepared.context.host,
      )
    : null;
  const before = snapshot ? selectOwned(snapshot, prepared.policy) : null;
  let rule: CloudflareCrawlerRule | null = null;
  if (!prepared.localOnly && data.operation !== 'cleanup') {
    if (data.operation === 'stop') rule = before ? { ...before, enabled: false } : null;
    else
      rule = {
        ref: prepared.policy.ref,
        action: 'block',
        expression: controlExpression(prepared.context.host, prepared.selected.body),
        description: `Liekan ${prepared.policy.ref} v${prepared.selected.version}: ${prepared.selected.body.name}`,
        enabled: true,
      };
  }
  if (snapshot && rule && !before && snapshot.rules.length >= snapshot.quota)
    conflict('当前 Zone 的自定义规则配额不足');
  const target: Target = {
    mode: 'apply',
    transfer: prepared.transfer,
    ...prepared.selected,
    ref: prepared.policy.ref,
    hostname: prepared.context.host,
    connectionId: prepared.connection?.id ?? null,
    localOnly: prepared.localOnly,
    rule,
    binding: binding(prepared.context, prepared.connection),
    before: {
      rule: before,
      hash: crawlerRemoteHash(before),
      rulesetId: snapshot?.rulesetId ?? null,
    },
    capabilities: snapshot
      ? {
          ...prepared.connection?.capabilities,
          quota: snapshot.quota,
          used: snapshot.rules.length,
          plan: snapshot.zone.plan,
          rulesReadable: true,
        }
      : { localOnly: true },
  };
  const impact = warehouseEnabled()
    ? await warehouseHistoricalImpact(websiteId, target.body)
    : null;
  return crawlerTransaction(async tx => {
    const context = await controlContext(
      tx,
      actor,
      websiteId,
      prepared.localOnly ? 'draft' : 'control',
    );
    const policy = await controlPolicy(tx, websiteId, policyId);
    assertPolicyContext(context, policy);
    const connection = prepared.connection
      ? await controlConnection(
          tx,
          context,
          websiteId,
          prepared.connection.id,
          data.operation === 'cleanup',
        )
      : null;
    if (
      policy.version !== prepared.policy.version ||
      policy.connection_id !== prepared.policy.connection_id ||
      context.generation !== prepared.context.generation ||
      context.host !== target.hostname ||
      controlHash(binding(context, connection)) !== controlHash(target.binding) ||
      policy.remote_hash !== prepared.policy.remote_hash ||
      (await tx.query(pendingSql, policy.id)).length
    )
      conflict();
    if (connection && target.transfer)
      await validateTransfer(tx, context, policy, target, connection);
    const id = randomUUID(),
      expiresAt = new Date(Date.now() + 600000);
    await tx.execute(
      `INSERT INTO liekan_crawler_preview(id,website_id,policy_id,connection_id,actor_id,generation,policy_version,operation,payload,fingerprint,expires_at)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9::jsonb,$10,$11)`,
      id,
      websiteId,
      policy.id,
      connection?.id ?? null,
      actor.id,
      context.generation,
      policy.version,
      data.operation,
      JSON.stringify(target),
      controlHash(target),
      expiresAt,
    );
    const searchBots = target.body.botIds.filter(id =>
      ['search', 'traditional_search', 'user'].includes(getCrawler(id).type),
    );
    const fullSite = target.body.paths.some(path => path.value === '/' && path.match === 'prefix');
    return {
      mode: 'apply' as const,
      transfer: target.transfer ?? null,
      id,
      expiresAt: expiresAt.toISOString(),
      operation: data.operation,
      policyId: policy.id,
      policyVersion: policy.version,
      targetVersion: target.version,
      hostname: target.hostname,
      paths: target.body.paths,
      expression: rule?.expression ?? null,
      before: target.before,
      after: { rule, body: target.body, version: target.version },
      impact: {
        searchBots,
        fullSite,
        historicalRequests7d: impact ?? (await historicalImpact(tx, websiteId, target.body)),
        otherRules: 'unknown',
        otherRulesSummary: snapshot
          ? { readable: true, count: snapshot.rules.filter(r => r.ref !== policy.ref).length }
          : { readable: false, count: null },
        acknowledgement:
          searchBots.length || fullSite
            ? '确认本预览即确认所列搜索、用户检索与整站范围影响。'
            : '确认本预览即确认上述路径与蜘蛛范围。',
      },
      capabilities: target.capabilities,
      limitations: [
        ...crawlerTemplateLimitations,
        '历史匹配为当前条件的估算，未调用 Cloudflare 模拟器。',
        '其他规则的优先级、跳过和遮蔽影响需要人工核对。',
      ],
      localOnly: target.localOnly,
    };
  });
}
async function adoptionScope(tx: AiTx, actor: CrawlerActor, websiteId: string, policyId: string) {
  const context = await controlContext(tx, actor, websiteId, 'control'),
    policy = await controlPolicy(tx, websiteId, policyId);
  assertPolicyRegistry(context, policy);
  const old = await previousConnection(tx, websiteId, policy),
    connection = await controlConnection(tx, context, websiteId);
  if (old.domain !== context.host || old.zone_id !== connection.zone_id)
    conflict('接管需要与原规则相同的域名和 Zone');
  if (!policy.remote_rule_id || !policy.remote_ruleset_id || !policy.remote_hash)
    conflict('请先明确核对旧操作结果，或在当前网站新建策略');
  if ((await tx.query(pendingSql, policy.id)).length)
    conflict('请先只读核对旧操作结果后再预览接管');
  return {
    context,
    policy,
    old,
    connection,
    transfer: transferFor(context, policy, old, connection),
  };
}
async function previewCrawlerAdoptionSnapshot(
  actor: CrawlerActor,
  websiteId: string,
  policyId: string,
) {
  const prepared = await crawlerTransaction(async tx => {
    const scope = await adoptionScope(tx, actor, websiteId, policyId);
    return { ...scope, selected: await targetBody(tx, scope.policy, { operation: 'stop' }) };
  });
  const snapshot = await readCrawlerCloudflare(
      controlToken(prepared.connection),
      prepared.connection.zone_id,
      prepared.context.host,
    ),
    rule = selectOwned(snapshot, prepared.policy);
  if (!rule) conflict('原规则已缺失，需要先核对远端结果');
  const impact = warehouseEnabled()
    ? await warehouseHistoricalImpact(websiteId, prepared.selected.body)
    : null;
  return crawlerTransaction(async tx => {
    const current = await adoptionScope(tx, actor, websiteId, policyId);
    if (
      current.policy.version !== prepared.policy.version ||
      current.policy.remote_hash !== prepared.policy.remote_hash ||
      controlHash(current.transfer) !== controlHash(prepared.transfer) ||
      controlHash(binding(current.context, current.connection)) !==
        controlHash(binding(prepared.context, prepared.connection))
    )
      conflict();
    const selected = await targetBody(tx, current.policy, { operation: 'stop' });
    const target: Target = {
      ...selected,
      mode: 'adopt',
      transfer: current.transfer,
      ref: current.policy.ref,
      hostname: current.context.host,
      connectionId: current.connection.id,
      localOnly: false,
      rule,
      binding: binding(current.context, current.connection),
      before: { rule, hash: crawlerRemoteHash(rule), rulesetId: snapshot.rulesetId },
      capabilities: {
        ...current.connection.capabilities,
        quota: snapshot.quota,
        used: snapshot.rules.length,
        plan: snapshot.zone.plan,
        rulesReadable: true,
      },
    };
    const id = randomUUID(),
      expiresAt = new Date(Date.now() + 600000);
    await tx.execute(
      `INSERT INTO liekan_crawler_preview(id,website_id,policy_id,connection_id,actor_id,generation,policy_version,operation,payload,fingerprint,expires_at)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,'deploy',$8::jsonb,$9,$10)`,
      id,
      websiteId,
      current.policy.id,
      current.connection.id,
      actor.id,
      current.context.generation,
      current.policy.version,
      JSON.stringify(target),
      controlHash(target),
      expiresAt,
    );
    const searchBots = target.body.botIds.filter(id =>
        ['search', 'traditional_search', 'user'].includes(getCrawler(id).type),
      ),
      fullSite = target.body.paths.some(path => path.value === '/' && path.match === 'prefix');
    return {
      id,
      expiresAt: expiresAt.toISOString(),
      mode: 'adopt' as const,
      transfer: current.transfer,
      operation: 'deploy' as const,
      policyId: current.policy.id,
      policyVersion: current.policy.version,
      targetVersion: target.version,
      hostname: target.hostname,
      paths: target.body.paths,
      expression: rule.expression,
      before: { ...target.before, registration: current.transfer.previous },
      after: {
        rule,
        body: target.body,
        draftBody: current.policy.body,
        version: target.version,
        registration: current.transfer.next,
      },
      impact: {
        searchBots,
        fullSite,
        historicalRequests7d: impact ?? (await historicalImpact(tx, websiteId, target.body)),
        otherRules: 'unknown',
        otherRulesSummary: {
          readable: true,
          count: snapshot.rules.filter(r => r.ref !== target.ref).length,
        },
        acknowledgement:
          '确认接管原规则及所列草稿，将后续管理绑定到当前归属和新凭据。接管会只读核对远端规则。',
      },
      capabilities: target.capabilities,
      limitations: [
        ...crawlerTemplateLimitations,
        '接管只更新本地规则登记。后续发布、停止或清理需要独立预览确认。',
      ],
      localOnly: false,
    };
  });
}
export function confirmCrawlerAdoption(
  actor: CrawlerActor,
  websiteId: string,
  policyId: string,
  input: z.infer<typeof crawlerConfirmInputSchema>,
) {
  return confirmCrawlerPolicy(actor, websiteId, policyId, 'deploy', input, 'adopt');
}
async function validateTarget(
  tx: AiTx,
  actor: CrawlerActor,
  job: Pick<
    DeploymentRow,
    'website_id' | 'policy_id' | 'generation' | 'policy_version' | 'operation' | 'target'
  >,
  requireEnabled = true,
) {
  const target = job.target as Target;
  const context = await controlContext(
    tx,
    actor,
    job.website_id,
    target.localOnly ? 'draft' : 'control',
  );
  const policy = await controlPolicy(tx, job.website_id, job.policy_id);
  if (target.mode === 'adopt') assertPolicyRegistry(context, policy);
  else assertPolicyContext(context, policy);
  if (!target.localOnly && requireEnabled && context.instance.control_paused)
    conflict('实例控制已暂停，需要管理员核对并恢复');
  let connection: ConnectionRow | null = null,
    registeredConnection: ConnectionRow | null = null;
  if (target.connectionId) {
    if (requireEnabled)
      connection = await controlConnection(
        tx,
        context,
        job.website_id,
        target.connectionId,
        job.operation === 'cleanup',
      );
    else {
      const [original] = await tx.query<ConnectionRow>(
        'SELECT * FROM liekan_crawler_connection WHERE id=$1::uuid AND website_id=$2::uuid FOR UPDATE',
        target.connectionId,
        job.website_id,
      );
      if (
        !original ||
        original.domain !== context.host ||
        original.owner_user_id !== context.website.ownerUserId ||
        original.team_id !== context.website.teamId
      )
        conflict();
      registeredConnection = original;
      if (
        original.token_encrypted &&
        (original.state === 'active' || original.state === 'cleanup')
      ) {
        assertConnectionContext(context, original, job.operation === 'cleanup');
        connection = original;
      } else {
        // A replacement credential may read the original Zone; it never inherits write authority for the old policy.
        connection = await controlConnection(tx, context, job.website_id);
        if (connection.zone_id !== original.zone_id)
          conflict('新连接需要属于原 Zone 才能核对这次操作');
      }
    }
  }
  // A newer read credential leaves the originally confirmed transfer registration intact.
  if (connection && target.transfer)
    await validateTransfer(tx, context, policy, target, registeredConnection ?? connection);
  const liveBinding = binding(context, connection);
  if (!requireEnabled) {
    // Read-only recovery preserves the confirmed target even when catalogue or quota facts advance.
    liveBinding.directoryHash = target.binding.directoryHash;
    liveBinding.capabilityFingerprint = target.binding.capabilityFingerprint;
    liveBinding.credentialFingerprint = target.binding.credentialFingerprint;
  }
  if (connection && requireEnabled) {
    // Uncertain provider writes retain Zone quarantine after credentials are erased or frozen.
    const unknown = await tx.query(
      `SELECT d.id FROM liekan_crawler_deployment d JOIN liekan_crawler_connection c ON c.id=d.connection_id
      WHERE c.zone_id=$1 AND d.state='unknown' LIMIT 1`,
      connection.zone_id,
    );
    if (unknown.length) conflict('此 Zone 有结果待确认的操作，请先核对后再执行变更');
  }
  if (
    context.generation !== job.generation ||
    policy.version !== job.policy_version ||
    context.host !== target.hostname ||
    controlHash(liveBinding) !== controlHash(target.binding)
  )
    conflict();
  if (
    policy.connection_id &&
    policy.connection_id !== target.connectionId &&
    !target.localOnly &&
    !target.transfer
  )
    conflict();
  if (
    target.mode === 'adopt' &&
    (!connection || !target.transfer || policy.generation !== target.transfer.previous.generation)
  )
    conflict();
  return { context, policy, connection };
}
export async function confirmCrawlerPolicy(
  actor: CrawlerActor,
  websiteId: string,
  policyId: string,
  operation: DeploymentRow['operation'],
  input: z.infer<typeof crawlerConfirmInputSchema>,
  mode: 'apply' | 'adopt' = 'apply',
) {
  const data = crawlerConfirmInputSchema.parse(input),
    inputHash = controlHash({
      websiteId: controlId(websiteId),
      policyId: controlId(policyId),
      operation,
      ...data,
      actorId: actor.id,
      ...(mode === 'adopt' ? { mode } : {}),
    });
  return crawlerTransaction(async tx => {
    await controlContext(tx, actor, websiteId, 'draft');
    const [existing] = await tx.query<DeploymentRow>(
      'SELECT * FROM liekan_crawler_deployment WHERE id=$1::uuid FOR UPDATE',
      data.operationId,
    );
    if (existing) {
      if (existing.input_hash !== inputHash) conflict('操作 ID 已用于其他确认内容');
      return deploymentDto(existing);
    }
    const [preview] = await tx.query<PreviewRow>(
      'SELECT * FROM liekan_crawler_preview WHERE id=$1::uuid AND website_id=$2::uuid AND policy_id=$3::uuid FOR UPDATE',
      data.previewId,
      websiteId,
      policyId,
    );
    if (
      !preview ||
      preview.actor_id !== actor.id ||
      preview.operation !== operation ||
      +new Date(preview.expires_at) <= Date.now()
    )
      conflict('预览已过期或属于其他操作，请重新预览');
    if ((preview.payload.mode === 'adopt' ? 'adopt' : 'apply') !== mode)
      conflict('请使用与预览一致的确认入口');
    if (controlHash(preview.payload) !== preview.fingerprint) conflict('预览内容校验失败');
    const { policy } = await validateTarget(tx, actor, { ...preview, target: preview.payload });
    if ((await tx.query(pendingSql, policy.id)).length) conflict('当前策略已有待完成操作');
    if (
      (
        await tx.query(
          'SELECT id FROM liekan_crawler_deployment WHERE preview_id=$1::uuid',
          preview.id,
        )
      ).length
    )
      conflict('该预览已确认，请为新操作重新预览');
    const [job] = await tx.query<DeploymentRow>(
      `INSERT INTO liekan_crawler_deployment(id,website_id,policy_id,connection_id,preview_id,actor_id,generation,operation,policy_version,input_hash,target)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,$10,$11::jsonb) RETURNING *`,
      data.operationId,
      websiteId,
      policy.id,
      preview.connection_id,
      preview.id,
      actor.id,
      preview.generation,
      operation,
      preview.policy_version,
      inputHash,
      JSON.stringify(preview.payload),
    );
    return deploymentDto(job);
  });
}
async function getJob(tx: AiTx, websiteId: string, operationId: string) {
  const [job] = await tx.query<DeploymentRow>(
    'SELECT * FROM liekan_crawler_deployment WHERE id=$1::uuid AND website_id=$2::uuid FOR UPDATE',
    controlId(operationId),
    controlId(websiteId),
  );
  if (!job) throw new LiekanError('蜘蛛操作不存在', 404);
  return job;
}
export async function getCrawlerDeployment(
  actor: CrawlerActor,
  websiteId: string,
  operationId: string,
) {
  return crawlerTransaction(async tx => {
    await controlContext(tx, actor, websiteId);
    return deploymentDto(await getJob(tx, websiteId, operationId));
  });
}
async function completeJob(
  job: DeploymentRow,
  snapshot: CloudflareCrawlerSnapshot | null,
  rule: CloudflareCrawlerRule | null,
) {
  const target = job.target as Target,
    result = {
      ruleId: rule?.id ?? job.before_snapshot?.rule?.id ?? target.before.rule?.id ?? null,
      rulesetId: snapshot?.rulesetId ?? target.before.rulesetId,
      remoteHash: crawlerRemoteHash(rule),
      confirmedAt: new Date().toISOString(),
      localOnly: target.localOnly,
      mode: target.mode === 'adopt' ? 'adopt' : 'apply',
      providerMutation:
        target.mode !== 'adopt' &&
        !target.localOnly &&
        !!(target.rule || job.before_snapshot?.rule || target.before.rule),
    };
  return crawlerTransaction(async tx => {
    if (target.mode === 'adopt') await validateTarget(tx, { id: job.actor_id, role: '' }, job);
    const [state] = await tx.query<{ generation: number; deleted_at: Date | null }>(
      'SELECT generation,deleted_at FROM liekan_crawler_state WHERE website_id=$1::uuid FOR UPDATE',
      job.website_id,
    );
    const [current] = await tx.query<DeploymentRow>(
      'SELECT * FROM liekan_crawler_deployment WHERE id=$1::uuid FOR UPDATE',
      job.id,
    );
    if (!current || !['running', 'unknown'].includes(current.state))
      return current ? deploymentDto(current) : null;
    if (target.mode === 'adopt') {
      const [preview] = await tx.query<{ expires_at: Date }>(
        'SELECT expires_at FROM liekan_crawler_preview WHERE id=$1::uuid',
        job.preview_id,
      );
      if (!preview || +new Date(preview.expires_at) <= Date.now())
        conflict('接管预览已过期，请重新预览确认');
    }
    // Preserve accepted provider facts even when the actor's role or website ownership changed during the request.
    await tx.execute(
      "UPDATE liekan_crawler_deployment SET state='confirmed',result=$2::jsonb,error_code=NULL,completed_at=now(),lease_until=NULL,lease_owner=NULL,updated_at=now() WHERE id=$1::uuid",
      job.id,
      JSON.stringify(result),
    );
    if (target.mode === 'adopt') {
      if (!state || state.deleted_at || state.generation !== job.generation || !target.transfer)
        conflict();
      await tx.execute(
        `UPDATE liekan_crawler_policy SET generation=$2,connection_id=$3::uuid,state=$4,applied_version=$5,remote_ruleset_id=$6,remote_rule_id=$7,remote_hash=$8,updated_at=now()
        WHERE id=$1::uuid AND generation=$9 AND version=$10`,
        job.policy_id,
        job.generation,
        target.connectionId,
        rule?.enabled ? 'enabled' : 'stopped',
        target.version,
        result.rulesetId,
        rule?.id ?? null,
        result.remoteHash,
        target.transfer.previous.generation,
        job.policy_version,
      );
    } else {
      // These are historical provider facts on the original generation; current ownership remains unadopted.
      await tx.execute(
        `UPDATE liekan_crawler_policy SET state=$2,applied_version=$3,connection_id=coalesce($4::uuid,connection_id),remote_ruleset_id=$5,remote_rule_id=$6,remote_hash=$7,updated_at=now()
        WHERE id=$1::uuid AND generation=$8 AND version=$9`,
        job.policy_id,
        job.operation === 'cleanup' ? 'stopped' : job.operation === 'stop' ? 'stopped' : 'enabled',
        target.version,
        target.connectionId,
        job.operation === 'cleanup' ? null : result.rulesetId,
        job.operation === 'cleanup' ? null : (rule?.id ?? null),
        job.operation === 'cleanup' ? null : result.remoteHash,
        job.generation,
        job.policy_version,
      );
    }
    if (job.connection_id && result.providerMutation)
      await tx.execute(
        `UPDATE liekan_crawler_connection SET capabilities=capabilities||'{"writeVerified":true}'::jsonb,updated_at=now() WHERE id=$1::uuid`,
        job.connection_id,
      );
    if (job.operation === 'cleanup' && job.connection_id) {
      const remaining = await tx.query(
        'SELECT id FROM liekan_crawler_policy WHERE connection_id=$1::uuid AND remote_rule_id IS NOT NULL LIMIT 1',
        job.connection_id,
      );
      if (!remaining.length)
        await tx.execute(
          "UPDATE liekan_crawler_connection SET token_encrypted=NULL,state='disconnected',cleanup_until=NULL,updated_at=now() WHERE id=$1::uuid AND state='cleanup'",
          job.connection_id,
        );
    }
    const updated = {
      ...current,
      state: 'confirmed' as const,
      result,
      error_code: null,
      completed_at: new Date(),
      updated_at: new Date(),
    };
    return deploymentDto(updated);
  });
}
async function markJob(job: DeploymentRow, state: 'unknown' | 'failed' | 'conflict', code: string) {
  await crawlerTransaction(tx =>
    tx.execute(
      `UPDATE liekan_crawler_deployment SET state=$2,error_code=$3,completed_at=CASE WHEN $2='unknown' THEN NULL ELSE now() END,lease_until=NULL,lease_owner=NULL,updated_at=now()
    WHERE id=$1::uuid AND state IN('queued','running','unknown')`,
      job.id,
      state,
      code,
    ),
  );
}
function readOwnedForRecovery(snapshot: CloudflareCrawlerSnapshot, job: DeploymentRow) {
  const target = job.target as Target,
    rule = ownedCrawlerRule(snapshot, target.ref),
    previous = job.before_snapshot ?? target.before;
  if (
    previous.rule?.id &&
    ((rule?.id !== previous.rule.id && rule !== null) || snapshot.rulesetId !== previous.rulesetId)
  )
    conflict('远端规则身份已变化');
  return rule;
}
async function reconcileWithSnapshot(
  job: DeploymentRow,
  snapshot: CloudflareCrawlerSnapshot,
  acknowledgeNotApplied: boolean,
) {
  const target = job.target as Target;
  let rule: CloudflareCrawlerRule | null;
  try {
    rule = readOwnedForRecovery(snapshot, job);
  } catch {
    await markJob(job, 'conflict', 'remote-identity-changed');
    return;
  }
  if (target.mode === 'adopt') {
    // The registration and confirmed ledger commit atomically. An interrupted adoption needs fresh consent.
    await markJob(
      job,
      crawlerRemoteHash(rule) === target.before.hash ? 'failed' : 'conflict',
      crawlerRemoteHash(rule) === target.before.hash
        ? 'adoption-interrupted'
        : 'remote-readback-different',
    );
    return;
  }
  if (crawlerDesiredMatches(rule, target.rule)) {
    await completeJob(job, snapshot, rule);
    return;
  }
  const before = job.before_snapshot ?? target.before;
  if (crawlerRemoteHash(rule) === before.hash) {
    if (acknowledgeNotApplied) await markJob(job, 'failed', 'operator-confirmed-not-applied');
    else await markJob(job, 'unknown', 'write-outcome-unconfirmed');
    return;
  }
  await markJob(job, 'conflict', 'remote-readback-different');
}
async function handoffRecoveryScope(
  tx: AiTx,
  actor: CrawlerActor,
  job: DeploymentRow,
  connectionId: string,
) {
  const context = await controlContext(tx, actor, job.website_id, 'control'),
    policy = await controlPolicy(tx, job.website_id, job.policy_id);
  assertPolicyRegistry(context, policy);
  const [old] = await tx.query<ConnectionRow>(
    'SELECT * FROM liekan_crawler_connection WHERE id=$1::uuid AND website_id=$2::uuid FOR UPDATE',
    job.connection_id,
    job.website_id,
  );
  const connection = await controlConnection(tx, context, job.website_id, connectionId),
    target = job.target as Target;
  if (
    !old ||
    old.domain !== context.host ||
    connection.zone_id !== old.zone_id ||
    target.hostname !== context.host ||
    target.ref !== policy.ref ||
    policy.generation !==
      (target.mode === 'adopt' ? target.transfer?.previous.generation : job.generation) ||
    policy.version !== job.policy_version
  )
    conflict('交接核对需要原域名、原 Zone 和原策略登记');
  const fingerprint = controlHash({
    generation: context.generation,
    policyGeneration: policy.generation,
    version: policy.version,
    connectionId: connection.id,
    credential: controlHash(connection.token_encrypted),
    ownerUserId: context.website.ownerUserId,
    teamId: context.website.teamId,
    host: context.host,
    zone: connection.zone_id,
    ref: policy.ref,
  });
  return { context, policy, connection, fingerprint };
}
export async function reconcileCrawlerDeployment(
  actor: CrawlerActor,
  websiteId: string,
  operationId: string,
  input: z.infer<typeof crawlerReconcileInput> = { acknowledgeNotApplied: false },
) {
  const data = crawlerReconcileInput.parse(input),
    leaseOwner = randomUUID();
  const prepared = await crawlerTransaction(async tx => {
    await controlContext(tx, actor, websiteId, 'control');
    const job = await getJob(tx, websiteId, operationId);
    if (job.state !== 'unknown')
      return { job, connection: null, leaseName: null, handoffFingerprint: null };
    const scope =
      data.acknowledgeHandoff && data.connectionId
        ? await handoffRecoveryScope(tx, actor, job, data.connectionId)
        : await validateTarget(tx, actor, job, false);
    const { connection } = scope;
    if (!connection) conflict('本地操作结果需要管理员核对');
    const leaseName = `crawler:${connection.zone_id}`;
    if (!(await acquireCrawlerLease(tx, leaseName, leaseOwner, 120)))
      conflict('此 Zone 正在核对或执行操作，请稍后重试');
    return {
      job,
      connection,
      leaseName,
      handoffFingerprint: 'fingerprint' in scope ? scope.fingerprint : null,
    };
  });
  if (!prepared.connection) return deploymentDto(prepared.job);
  try {
    const snapshot = await readCrawlerCloudflare(
      controlToken(prepared.connection),
      prepared.connection.zone_id,
      prepared.connection.domain,
    );
    // Recheck current authority after the remote read, before accepting an explicit resolution.
    await crawlerTransaction(async tx => {
      if (data.acknowledgeHandoff && data.connectionId) {
        const current = await handoffRecoveryScope(tx, actor, prepared.job, data.connectionId);
        if (current.fingerprint !== prepared.handoffFingerprint)
          conflict('交接核对期间当前归属或凭据已变化');
      } else await validateTarget(tx, actor, prepared.job, false);
    });
    await reconcileWithSnapshot(prepared.job, snapshot, data.acknowledgeNotApplied);
  } finally {
    if (prepared.leaseName)
      await crawlerTransaction(tx =>
        releaseCrawlerLease(tx, prepared.leaseName as string, leaseOwner),
      );
  }
  return getCrawlerDeployment(actor, websiteId, operationId);
}
async function globalHandoffRecoveryScope(
  tx: AiTx,
  actor: CrawlerActor,
  data: z.infer<typeof crawlerHandoffReconcileInput>,
) {
  const context = await controlContext(tx, actor, data.websiteId, 'control');
  const [job] = await tx.query<DeploymentRow>(
    'SELECT * FROM liekan_crawler_deployment WHERE id=$1::uuid FOR UPDATE',
    data.deploymentId,
  );
  if (!job) throw new LiekanError('蜘蛛交接操作不存在', 404);
  const [original] = await tx.query<ConnectionRow>(
    'SELECT * FROM liekan_crawler_connection WHERE id=$1::uuid AND website_id=$2::uuid FOR UPDATE',
    job.connection_id,
    job.website_id,
  );
  if (!original) throw new LiekanError('蜘蛛交接记录不可访问', 404);
  const originalAccess = await authorizeCrawlerHandoff(tx, actor, original);
  if (
    +new Date(original.updated_at) <= Date.now() - 180 * 24 * 60 * 60 * 1000 &&
    originalAccess.role !== 'admin'
  )
    throw new LiekanError('蜘蛛交接记录已超过保留期', 404);
  const policy = await controlPolicy(tx, job.website_id, job.policy_id),
    connection = await controlConnection(tx, context, data.websiteId, data.connectionId),
    target = job.target as Target;
  assertPolicyRegistry(context, policy);
  if (
    target.localOnly ||
    target.connectionId !== original.id ||
    target.hostname !== original.domain ||
    context.host !== original.domain ||
    connection.zone_id !== original.zone_id ||
    target.ref !== policy.ref ||
    target.binding.ownerUserId !== original.owner_user_id ||
    target.binding.teamId !== original.team_id ||
    policy.generation !==
      (target.mode === 'adopt' ? target.transfer?.previous.generation : job.generation) ||
    policy.version !== job.policy_version
  )
    conflict('交接核对需要原域名、原 Zone 和原策略登记');
  if (target.transfer) {
    const transfer = target.transfer,
      [previous] = await tx.query<ConnectionRow>(
        'SELECT * FROM liekan_crawler_connection WHERE id=$1::uuid AND website_id=$2::uuid FOR UPDATE',
        transfer.previous.connectionId,
        job.website_id,
      );
    if (
      !previous ||
      previous.domain !== original.domain ||
      previous.zone_id !== original.zone_id ||
      controlHash(transfer.previous) !==
        controlHash({
          connectionId: previous.id,
          generation: policy.generation,
          ownerUserId: previous.owner_user_id,
          teamId: previous.team_id,
        }) ||
      controlHash(transfer.next) !==
        controlHash({
          connectionId: original.id,
          generation: job.generation,
          ownerUserId: original.owner_user_id,
          teamId: original.team_id,
        }) ||
      ![previous.id, original.id].includes(policy.connection_id ?? '')
    )
      conflict('原确认的连接交接登记已变化');
  } else if (policy.connection_id && policy.connection_id !== original.id) {
    conflict('原策略连接登记已变化');
  }
  const fingerprint = controlHash({
    originalAccess,
    original: { id: original.id, ownerUserId: original.owner_user_id, teamId: original.team_id },
    target: controlHash(target),
    before: controlHash(job.before_snapshot),
    policy: {
      generation: policy.generation,
      version: policy.version,
      connectionId: policy.connection_id,
      ref: policy.ref,
      ruleId: policy.remote_rule_id,
      rulesetId: policy.remote_ruleset_id,
      hash: policy.remote_hash,
    },
    current: {
      websiteId: data.websiteId,
      generation: context.generation,
      ownerUserId: context.website.ownerUserId,
      teamId: context.website.teamId,
      role: context.website.role,
      teamRole: context.website.teamRole,
      connectionId: connection.id,
      credential: controlHash(connection.token_encrypted),
      host: context.host,
      zone: connection.zone_id,
    },
  });
  return { job, connection, fingerprint };
}
/** Explicitly resolves historical facts using a current read credential; registration stays in the original space. */
export async function reconcileCrawlerHandoffDeployment(
  actor: CrawlerActor,
  input: z.infer<typeof crawlerHandoffReconcileInput>,
) {
  const data = crawlerHandoffReconcileInput.parse(input),
    leaseOwner = randomUUID(),
    prepared = await crawlerTransaction(async tx => {
      const scope = await globalHandoffRecoveryScope(tx, actor, data);
      if (scope.job.state !== 'unknown') return { ...scope, leaseName: null };
      const leaseName = `crawler:${scope.connection.zone_id}`;
      if (!(await acquireCrawlerLease(tx, leaseName, leaseOwner, 120)))
        conflict('此 Zone 正在核对或执行操作，请稍后重试');
      return { ...scope, leaseName };
    });
  if (!prepared.leaseName) return deploymentDto(prepared.job);
  try {
    const snapshot = await readCrawlerCloudflare(
      controlToken(prepared.connection),
      prepared.connection.zone_id,
      prepared.connection.domain,
    );
    await crawlerTransaction(async tx => {
      const current = await globalHandoffRecoveryScope(tx, actor, data),
        [lease] = await tx.query(
          'SELECT name FROM liekan_crawler_lease WHERE name=$1 AND owner=$2::uuid AND expires_at>now() FOR SHARE',
          prepared.leaseName,
          leaseOwner,
        );
      if (!lease || current.job.state !== 'unknown' || current.fingerprint !== prepared.fingerprint)
        conflict('交接核对期间原归属、当前权限、凭据或操作登记已变化');
    });
    await reconcileWithSnapshot(prepared.job, snapshot, data.acknowledgeNotApplied);
    return await crawlerTransaction(async tx => {
      const scope = await globalHandoffRecoveryScope(tx, actor, data);
      return deploymentDto(scope.job);
    });
  } finally {
    await crawlerTransaction(tx => releaseCrawlerLease(tx, prepared.leaseName, leaseOwner));
  }
}
/** At most one bounded operation per worker tick; expired running jobs only enter read-only recovery. */
export async function processCrawlerDeployment(workerId: string) {
  controlId(workerId);
  const leaseOwner = randomUUID();
  const claimed = await crawlerTransaction(async tx => {
    const [instance] = await tx.query<{ control_paused: boolean }>(
      'SELECT control_paused FROM liekan_crawler_instance WHERE singleton=true FOR SHARE',
    );
    const candidates = await tx.query<DeploymentRow>(
      `SELECT * FROM liekan_crawler_deployment WHERE
      (state='queued' AND (NOT $1 OR coalesce((target->>'localOnly')::boolean,false))) OR
      (state='running' AND lease_until<now()) OR (state='unknown' AND updated_at<now()-interval '1 minute' AND (lease_until IS NULL OR lease_until<now()))
      ORDER BY created_at,id LIMIT 20 FOR UPDATE SKIP LOCKED`,
      instance?.control_paused ?? true,
    );
    for (const job of candidates) {
      const [connection] = job.connection_id
        ? await tx.query<ConnectionRow>(
            'SELECT * FROM liekan_crawler_connection WHERE id=$1::uuid',
            job.connection_id,
          )
        : [];
      const leaseName = connection
        ? `crawler:${connection.zone_id}`
        : `crawler-local:${job.website_id}`;
      if (!(await acquireCrawlerLease(tx, leaseName, leaseOwner, 120))) continue;
      const recovering = job.state !== 'queued';
      await tx.execute(
        `UPDATE liekan_crawler_deployment SET state=$2,started_at=coalesce(started_at,now()),lease_owner=$3::uuid,lease_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=now() WHERE id=$1::uuid`,
        job.id,
        recovering ? 'unknown' : 'running',
        leaseOwner,
      );
      return {
        job: { ...job, state: recovering ? ('unknown' as const) : ('running' as const) },
        leaseName,
        recovering,
      };
    }
    return null;
  });
  if (!claimed) return null;
  const { job } = claimed,
    target = job.target as Target,
    actor = { id: job.actor_id, role: '' };
  let dispatched = false,
    writeAccepted = false;
  try {
    const prepared = await crawlerTransaction(async tx => {
      const context = await validateTarget(tx, actor, job, !claimed.recovering);
      const [preview] = await tx.query<PreviewRow>(
        'SELECT * FROM liekan_crawler_preview WHERE id=$1::uuid',
        job.preview_id,
      );
      if (
        !claimed.recovering &&
        (!preview ||
          +new Date(preview.expires_at) <= Date.now() ||
          preview.fingerprint !== controlHash(target))
      )
        conflict('排队预览已过期，请重新预览确认');
      return context;
    });
    if (target.localOnly) {
      await completeJob(job, null, null);
      return job.id;
    }
    const connection = prepared.connection;
    if (!connection) conflict();
    const snapshot = await readCrawlerCloudflare(
      controlToken(connection),
      connection.zone_id,
      target.hostname,
    );
    if (claimed.recovering) {
      await reconcileWithSnapshot(job, snapshot, false);
      return job.id;
    }
    const previous = selectOwned(snapshot, prepared.policy);
    if (
      crawlerRemoteHash(previous) !== target.before.hash ||
      snapshot.rulesetId !== target.before.rulesetId
    )
      conflict('预览后的远端状态已变化，请重新预览');
    if (
      target.capabilities.quota !== snapshot.quota ||
      target.capabilities.plan !== snapshot.zone.plan ||
      target.capabilities.used !== snapshot.rules.length
    )
      conflict('预览后的套餐或规则使用量已变化，请重新预览');
    if (target.rule && !previous && snapshot.rules.length >= snapshot.quota)
      conflict('当前 Zone 的自定义规则配额不足');
    // This is the final live authority check. No network call holds a database transaction.
    await crawlerTransaction(async tx => {
      await validateTarget(tx, actor, job);
      const [current] = await tx.query<DeploymentRow>(
        'SELECT * FROM liekan_crawler_deployment WHERE id=$1::uuid FOR UPDATE',
        job.id,
      );
      const [preview] = await tx.query<PreviewRow>(
        'SELECT * FROM liekan_crawler_preview WHERE id=$1::uuid',
        job.preview_id,
      );
      if (
        current?.state !== 'running' ||
        current.lease_owner !== leaseOwner ||
        !current.lease_until ||
        +new Date(current.lease_until) <= Date.now() ||
        !preview ||
        +new Date(preview.expires_at) <= Date.now()
      )
        conflict('操作权限、租约或预览已失效');
      await tx.execute(
        'UPDATE liekan_crawler_deployment SET before_snapshot=$2::jsonb,updated_at=now() WHERE id=$1::uuid',
        job.id,
        JSON.stringify({
          rule: previous,
          hash: crawlerRemoteHash(previous),
          rulesetId: snapshot.rulesetId,
        }),
      );
    });
    if (target.mode === 'adopt') {
      await completeJob(
        {
          ...job,
          before_snapshot: {
            rule: previous,
            hash: crawlerRemoteHash(previous),
            rulesetId: snapshot.rulesetId,
          },
        },
        snapshot,
        previous,
      );
      return job.id;
    }
    // Set before entering the provider boundary: a process/database failure after dispatch cannot authorize a retry.
    dispatched = true;
    await writeCrawlerCloudflare(
      controlToken(connection),
      connection.zone_id,
      snapshot,
      previous,
      target.rule,
    );
    writeAccepted = true;
    const after = await readCrawlerCloudflare(
      controlToken(connection),
      connection.zone_id,
      target.hostname,
    );
    let actual: CloudflareCrawlerRule | null;
    try {
      actual = readOwnedForRecovery(after, {
        ...job,
        before_snapshot: {
          rule: previous,
          hash: crawlerRemoteHash(previous),
          rulesetId: snapshot.rulesetId,
        },
      });
    } catch {
      await markJob(job, 'conflict', 'remote-identity-changed');
      return job.id;
    }
    if (!crawlerDesiredMatches(actual, target.rule)) {
      await markJob(job, 'conflict', 'remote-readback-different');
      return job.id;
    }
    await completeJob(
      {
        ...job,
        before_snapshot: {
          rule: previous,
          hash: crawlerRemoteHash(previous),
          rulesetId: snapshot.rulesetId,
        },
      },
      after,
      actual,
    );
    return job.id;
  } catch (error) {
    const uncertain =
      claimed.recovering ||
      (dispatched &&
        (writeAccepted || !(error instanceof CrawlerProviderError) || error.uncertain));
    try {
      await markJob(
        job,
        uncertain
          ? 'unknown'
          : error instanceof LiekanError && error.status === 409
            ? 'conflict'
            : 'failed',
        error instanceof CrawlerProviderError
          ? error.code
          : uncertain
            ? 'local-result-unconfirmed'
            : error instanceof LiekanError && error.status === 409
              ? 'context-or-remote-changed'
              : 'control-unavailable',
      );
    } catch {
      /* The durable running row is recovered as unknown after its lease expires. */
    }
    return job.id;
  } finally {
    await crawlerTransaction(tx => releaseCrawlerLease(tx, claimed.leaseName, leaseOwner));
  }
}

export const previewCrawlerPolicy: typeof previewCrawlerPolicySnapshot = (...args) =>
  warehouseEnabled()
    ? withinWarehouseReport(() => previewCrawlerPolicySnapshot(...args))
    : previewCrawlerPolicySnapshot(...args);
export const previewCrawlerAdoption: typeof previewCrawlerAdoptionSnapshot = (...args) =>
  warehouseEnabled()
    ? withinWarehouseReport(() => previewCrawlerAdoptionSnapshot(...args))
    : previewCrawlerAdoptionSnapshot(...args);
