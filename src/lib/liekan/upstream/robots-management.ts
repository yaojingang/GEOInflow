import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AiTx } from './ai-db';
import { authorizeCrawler, crawlerTransaction, type CrawlerActor } from './crawler-access';
import { LiekanError } from './errors';
import { hostname } from '../log-ingestion/protocol';
import { tokenHash } from '../log-ingestion/secrets';
import { publicCrawlerProbe } from '../crawler-control/public-probe';
import { verifyCrawlerDomain } from '../crawler-control/diagnostics';
import { parseRobots } from '../crawlers/robots';
import { acquireCrawlerLease, releaseCrawlerLease } from '../crawler-control/leases';
import type {
  RobotsAgentInput,
  RobotsManagementInput,
  RobotsManagement,
} from '../contracts/robots-management';

export const robotsDigest = (content: string | null) =>
  createHash('sha256')
    .update(content === null ? 'missing\0' : `present\0${content}`)
    .digest('hex');
export async function pauseRobotsForRestore(tx: AiTx) {
  const [available] = await tx.query(
    "SELECT to_regclass('liekan_robots_state') IS NOT NULL AS present",
  );
  if (!available.present) return;
  await tx.execute(
    'UPDATE liekan_robots_state SET agent_enabled=false,agent_context=NULL,pair_hash=NULL,pair_expires=NULL,pair_actor=NULL,pair_context=NULL,monitor=false,monitor_actor=NULL,context=NULL,hostname=NULL,check_lease=NULL,checking_until=NULL',
  );
  await tx.execute(
    "UPDATE liekan_robots_deployment SET state='cancelled',error_code='restore-confirmation-required' WHERE state='preview'",
  );
  // Backup state can precede a helper lease and write, so queued jobs also require readback.
  await tx.execute(
    "UPDATE liekan_robots_deployment SET state='unknown',error_code='restore-readback-required',lease_until=now() WHERE state IN ('queued','leased')",
  );
}
const contextOf = (site: { domain: string; ownerUserId: string | null; teamId: string | null }) =>
  createHash('sha256')
    .update(JSON.stringify([site.domain, site.ownerUserId, site.teamId]))
    .digest('hex');
const active = "('queued','leased','applied','unknown')";
async function stateFor(tx: AiTx, id: string) {
  await tx.execute(
    `INSERT INTO liekan_robots_state(website_id,draft) SELECT $1::uuid,COALESCE((SELECT robots FROM liekan_setting WHERE website_id=$1::uuid),'') ON CONFLICT DO NOTHING`,
    id,
  );
  return (
    await tx.query('SELECT * FROM liekan_robots_state WHERE website_id=$1::uuid FOR UPDATE', id)
  )[0];
}
async function assertIdle(tx: AiTx, id: string) {
  if (
    (
      await tx.query(
        `SELECT id FROM liekan_robots_deployment WHERE website_id=$1::uuid AND state IN ${active} LIMIT 1`,
        id,
      )
    ).length
  )
    throw new LiekanError('请先等待或核对当前 robots 发布任务', 409);
}
export async function getRobotsManagement(
  actor: CrawlerActor,
  id: string,
): Promise<RobotsManagement> {
  return crawlerTransaction(async tx => {
    const site = await authorizeCrawler(tx, actor, id);
    const s = (
      await tx.query('SELECT * FROM liekan_robots_state WHERE website_id=$1::uuid', id)
    )[0];
    const [settings] = s
      ? []
      : await tx.query('SELECT robots FROM liekan_setting WHERE website_id=$1::uuid', id);
    return {
      hostname: hostname(site.domain),
      draft: s?.draft ?? settings?.robots ?? '',
      revision: s?.revision ?? 1,
      monitor: s?.monitor ?? false,
      interval: s?.interval_minutes ?? 60,
      checkedAt: s?.checked_at ?? null,
      observedContent: s?.observed_content ?? null,
      observedHostname: s?.observed_hostname ?? null,
      observedStatus: s?.observed_status ?? null,
      lastError: s?.last_error ?? null,
      changePending: s?.change_pending ?? false,
      agent: {
        connected: Boolean(s?.agent_enabled),
        seenAt: s?.agent_seen_at ?? null,
        path: s?.target_path ?? null,
        contextValid: s?.agent_context === contextOf(site),
      },
      permissions: { canDraft: site.canDraft, canControl: site.canControl },
      snapshots: await tx.query(
        'SELECT id,content,hostname,status,created_at FROM liekan_robots_snapshot WHERE website_id=$1::uuid ORDER BY created_at DESC,id DESC LIMIT 20',
        id,
      ),
      deployments: await tx.query(
        `SELECT id,state,before_content,content,created_at,expires_at,rollback_of,error_code FROM liekan_robots_deployment WHERE website_id=$1::uuid ORDER BY (state IN ${active}) DESC,created_at DESC,id DESC LIMIT 20`,
        id,
      ),
    };
  });
}
async function probeRobots(id: string, host: string) {
  const owner = randomUUID();
  const slot = await crawlerTransaction(async tx => {
    for (const name of ['probe:0', 'probe:1'])
      if (await acquireCrawlerLease(tx, name, owner, 60)) return name;
    throw new LiekanError('公开检查繁忙，请稍后重试', 429);
  });
  try {
    await verifyCrawlerDomain(id, host);
    const result = await publicCrawlerProbe(host, '/robots.txt', owner, true);
    if (![200, 404].includes(result.status))
      throw new LiekanError('robots 公开地址返回异常状态', 503);
    if (result.status === 200 && /text\/html/i.test(result.headers['content-type'] ?? ''))
      throw new LiekanError('robots 公开地址返回 HTML，请检查网站配置', 409);
    return { content: result.status === 200 ? (result.body ?? '') : null, status: result.status };
  } finally {
    await crawlerTransaction(tx => releaseCrawlerLease(tx, slot, owner));
  }
}
async function recordProbe(
  tx: AiTx,
  id: string,
  content: string | null,
  status: number,
  host: string,
) {
  const s = await stateFor(tx, id);
  const digest = robotsDigest(content);
  const changed =
    s.observed_hash !== null &&
    (s.observed_hash !== digest || s.observed_status !== status || s.observed_hostname !== host);
  if (s.observed_hash !== digest || s.observed_status !== status || s.observed_hostname !== host) {
    await tx.execute(
      'INSERT INTO liekan_robots_snapshot(id,website_id,content,status,digest,hostname) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6)',
      randomUUID(),
      id,
      content,
      status,
      digest,
      host,
    );
  }
  await tx.execute(
    'UPDATE liekan_robots_state SET observed_content=$2,observed_status=$3,observed_hash=$4,checked_at=now(),last_error=NULL,change_pending=change_pending OR $5,observed_hostname=$6 WHERE website_id=$1::uuid',
    id,
    content,
    status,
    digest,
    changed,
    host,
  );
}
export async function changeRobotsManagement(
  actor: CrawlerActor,
  id: string,
  input: RobotsManagementInput,
) {
  if (input.action === 'read') {
    const prepared = await crawlerTransaction(async tx => {
      const site = await authorizeCrawler(tx, actor, id, 'draft');
      const s = await stateFor(tx, id),
        lease = randomUUID();
      if (
        +new Date(s.checking_until) > Date.now() ||
        +new Date(s.last_read_at) > Date.now() - 60000
      )
        throw new LiekanError('每个网站每分钟最多进行一次检查，请等待当前检查完成', 429);
      await tx.execute(
        "UPDATE liekan_robots_state SET check_lease=$2::uuid,checking_until=now()+interval '60 seconds',last_read_at=now() WHERE website_id=$1::uuid",
        id,
        lease,
      );
      return { host: hostname(site.domain), context: contextOf(site), lease };
    });
    try {
      const result = await probeRobots(id, prepared.host);
      await crawlerTransaction(async tx => {
        const site = await authorizeCrawler(tx, actor, id, 'draft');
        const s = await stateFor(tx, id);
        if (contextOf(site) !== prepared.context || s.check_lease !== prepared.lease)
          throw new LiekanError('网站归属或域名已变化', 409);
        await recordProbe(tx, id, result.content, result.status, prepared.host);
        await tx.execute(
          "UPDATE liekan_robots_state SET check_lease=NULL,checking_until=NULL,next_check=now()+interval '1 minute'*interval_minutes WHERE website_id=$1::uuid",
          id,
        );
      });
    } catch (error) {
      await crawlerTransaction(tx =>
        tx.execute(
          "UPDATE liekan_robots_state SET check_lease=NULL,checking_until=NULL,last_error='public-check-unavailable' WHERE website_id=$1::uuid AND check_lease=$2::uuid",
          id,
          prepared.lease,
        ),
      );
      throw error;
    }
    return getRobotsManagement(actor, id);
  }
  const output = await crawlerTransaction(async tx => {
    const mode = ['save', 'acknowledge'].includes(input.action) ? 'draft' : 'control';
    const site = await authorizeCrawler(tx, actor, id, mode);
    const s = await stateFor(tx, id);
    const context = contextOf(site),
      host = hostname(site.domain);
    switch (input.action) {
      case 'save':
        if (s.revision !== input.revision)
          throw new LiekanError('robots 草稿已被更新，请重新读取后合并', 409);
        await tx.execute(
          'UPDATE liekan_robots_state SET draft=$2,revision=revision+1 WHERE website_id=$1::uuid',
          id,
          input.content,
        );
        await tx.execute(
          'INSERT INTO liekan_setting(website_id,robots) VALUES($1::uuid,$2) ON CONFLICT(website_id) DO UPDATE SET robots=$2,updated_at=now()',
          id,
          input.content,
        );
        break;
      case 'monitor':
        await tx.execute(
          'UPDATE liekan_robots_state SET monitor=$2,interval_minutes=$3,monitor_actor=$4::uuid,context=$5,hostname=$6,next_check=now(),check_lease=NULL,checking_until=NULL WHERE website_id=$1::uuid',
          id,
          input.enabled,
          input.interval,
          actor.id,
          context,
          host,
        );
        break;
      case 'acknowledge':
        await tx.execute(
          'UPDATE liekan_robots_state SET change_pending=false WHERE website_id=$1::uuid',
          id,
        );
        break;
      case 'pair': {
        await assertIdle(tx, id);
        const code = randomBytes(32).toString('base64url');
        await tx.execute(
          "UPDATE liekan_robots_state SET pair_hash=$2,pair_expires=now()+interval '10 minutes',pair_actor=$3::uuid,pair_context=$4 WHERE website_id=$1::uuid",
          id,
          tokenHash(code),
          actor.id,
          context,
        );
        return { code, hostname: host };
      }
      case 'revoke':
        await tx.execute(
          'UPDATE liekan_robots_state SET agent_enabled=false,pair_hash=NULL,pair_expires=NULL WHERE website_id=$1::uuid',
          id,
        );
        await tx.execute(
          "UPDATE liekan_robots_deployment SET state='cancelled' WHERE website_id=$1::uuid AND state IN ('queued','preview')",
          id,
        );
        break;
      case 'preview': {
        await assertIdle(tx, id);
        if (
          !s.agent_enabled ||
          s.agent_context !== context ||
          !s.agent_hash ||
          +new Date(s.agent_seen_at) < Date.now() - 90000
        )
          throw new LiekanError('请先连接当前网站的 robots 服务器助手并等待文件同步', 409);
        let content = s.draft;
        if (input.rollbackOf) {
          const [old] = await tx.query(
            'SELECT * FROM liekan_robots_deployment WHERE id=$1::uuid AND website_id=$2::uuid AND applied_at IS NOT NULL',
            input.rollbackOf,
            id,
          );
          if (!old || old.context !== context || old.agent_id !== s.agent_id)
            throw new LiekanError('此版本无法用于当前服务器回滚', 409);
          content = old.before_content;
        }
        if (content !== null && parseRobots(content).issues.length)
          throw new LiekanError('robots 内容存在语法问题，请修正后发布', 400);
        const deploymentId = randomUUID();
        await tx.execute(
          "INSERT INTO liekan_robots_deployment(id,website_id,actor_id,agent_id,context,hostname,revision,expected_hash,target_hash,before_content,content,rollback_of,state) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12::uuid,'preview')",
          deploymentId,
          id,
          actor.id,
          s.agent_id,
          context,
          host,
          s.revision,
          s.agent_hash,
          robotsDigest(content),
          s.agent_content,
          content,
          input.rollbackOf ?? null,
        );
        return { id: deploymentId };
      }
      case 'confirm': {
        const [job] = await tx.query(
          'SELECT * FROM liekan_robots_deployment WHERE id=$1::uuid AND website_id=$2::uuid FOR UPDATE',
          input.id,
          id,
        );
        if (!job) throw new LiekanError('robots 发布预览不存在', 404);
        if (job.state !== 'preview') return { id: job.id };
        await assertIdle(tx, id);
        if (
          +new Date(job.expires_at) < Date.now() ||
          job.context !== context ||
          job.agent_id !== s.agent_id ||
          !s.agent_enabled ||
          s.agent_context !== context ||
          job.revision !== s.revision ||
          job.expected_hash !== s.agent_hash ||
          +new Date(s.agent_seen_at) < Date.now() - 90000
        )
          throw new LiekanError('robots 发布预览已失效，请重新预览', 409);
        await tx.execute(
          "UPDATE liekan_robots_deployment SET state='queued',actor_id=$2::uuid WHERE id=$1::uuid",
          job.id,
          actor.id,
        );
        return { id: job.id };
      }
      case 'verify':
        await assertIdle(tx, id);
        await tx.execute(
          "UPDATE liekan_robots_deployment SET state='applied',verify_after=now(),verify_deadline=now()+interval '10 minutes' WHERE id=$1::uuid AND website_id=$2::uuid AND state='verification_failed'",
          input.id,
          id,
        );
        break;
      case 'reconcile': {
        const [job] = await tx.query(
          "SELECT * FROM liekan_robots_deployment WHERE id=$1::uuid AND website_id=$2::uuid AND state='unknown' FOR UPDATE",
          input.id,
          id,
        );
        if (
          !job ||
          job.agent_id !== s.agent_id ||
          +new Date(s.agent_seen_at) <= +new Date(job.lease_until) ||
          +new Date(s.agent_seen_at) < Date.now() - 90000
        )
          throw new LiekanError('请等待服务器助手同步后核对未知任务', 409);
        const applied = s.agent_hash === job.target_hash;
        if (!applied && s.agent_hash !== job.expected_hash)
          throw new LiekanError('服务器文件与发布前后版本均不一致，请人工核对', 409);
        await tx.execute(
          "UPDATE liekan_robots_deployment SET state=$2,applied_at=CASE WHEN $2='applied' THEN now() ELSE applied_at END,verify_after=now(),verify_deadline=now()+interval '10 minutes',error_code=NULL WHERE id=$1::uuid",
          job.id,
          applied ? 'applied' : 'failed',
        );
        break;
      }
    }
    return {};
  });
  return { ...output, data: await getRobotsManagement(actor, id) };
}

export async function robotsAgentRequest(input: RobotsAgentInput, token?: string) {
  return crawlerTransaction(async tx => {
    if (input.action === 'pair') {
      const [s] = await tx.query(
        'SELECT * FROM liekan_robots_state WHERE pair_hash=$1 AND pair_expires>now() FOR UPDATE',
        tokenHash(input.code),
      );
      if (!s) throw new LiekanError('robots 授权码已失效', 401);
      const site = await authorizeCrawler(
        tx,
        { id: s.pair_actor, role: '' },
        s.website_id,
        'control',
      );
      if (contextOf(site) !== s.pair_context) throw new LiekanError('网站归属或域名已变化', 409);
      await assertIdle(tx, s.website_id);
      const credential = randomBytes(32).toString('base64url'),
        agentId = randomUUID();
      await tx.execute(
        'UPDATE liekan_robots_state SET agent_id=$2::uuid,agent_enabled=true,credential_hash=$3,agent_actor=pair_actor,agent_context=pair_context,target_path=$4,agent_seen_at=NULL,agent_hash=NULL,agent_content=NULL,pair_hash=NULL,pair_expires=NULL WHERE website_id=$1::uuid',
        s.website_id,
        agentId,
        tokenHash(credential),
        input.path,
      );
      return {
        token: credential,
        agentId,
        hostname: hostname(site.domain),
        websiteId: s.website_id,
      };
    }
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new LiekanError('需要 robots 服务器凭据', 401);
    const [s] = await tx.query(
      'SELECT * FROM liekan_robots_state WHERE credential_hash=$1 FOR UPDATE',
      tokenHash(token),
    );
    if (!s) throw new LiekanError('robots 服务器凭据无效', 401);
    let ack: string | null = null;
    if (input.receipt) {
      const receipt = input.receipt;
      const [job] = await tx.query(
        'SELECT * FROM liekan_robots_deployment WHERE id=$1::uuid AND website_id=$2::uuid AND agent_id=$3::uuid FOR UPDATE',
        receipt.id,
        s.website_id,
        s.agent_id,
      );
      if (
        job &&
        [
          'leased',
          'unknown',
          'applied',
          'verified',
          'verification_failed',
          'conflict',
          'failed',
        ].includes(job.state)
      ) {
        if (['leased', 'unknown'].includes(job.state)) {
          const state =
            receipt.state === 'applied' && receipt.hash !== job.target_hash
              ? 'unknown'
              : receipt.state;
          await tx.execute(
            "UPDATE liekan_robots_deployment SET state=$2,error_code=CASE WHEN $2='applied' THEN NULL ELSE $2 END,applied_at=CASE WHEN $2='applied' THEN now() ELSE applied_at END,verify_after=now(),verify_deadline=now()+interval '10 minutes' WHERE id=$1::uuid",
            job.id,
            state,
          );
        }
        ack = job.id;
      }
    }
    const digest = robotsDigest(input.content);
    await tx.execute(
      'UPDATE liekan_robots_state SET agent_seen_at=now(),agent_content=$2,agent_hash=$3 WHERE website_id=$1::uuid',
      s.website_id,
      input.content,
      digest,
    );
    // Retired credentials can submit read-only evidence and receipts; only a current binding can receive jobs.
    let site;
    try {
      site = await authorizeCrawler(tx, { id: s.agent_actor, role: '' }, s.website_id, 'control');
    } catch (error) {
      if (!(error instanceof LiekanError) || ![401, 403, 404].includes(error.status)) throw error;
      return { ack, revoked: true, job: null };
    }
    if (!s.agent_enabled || contextOf(site) !== s.agent_context)
      return { ack, revoked: true, job: null };
    await tx.execute(
      "UPDATE liekan_robots_deployment SET state='unknown',error_code='receipt-missing' WHERE website_id=$1::uuid AND state='leased' AND lease_until<now()",
      s.website_id,
    );
    const [job] = await tx.query(
      "SELECT * FROM liekan_robots_deployment WHERE website_id=$1::uuid AND state='queued' ORDER BY created_at LIMIT 1 FOR UPDATE",
      s.website_id,
    );
    if (!job) return { ack, job: null };
    let valid =
      job.agent_id === s.agent_id &&
      job.context === contextOf(site) &&
      job.expected_hash === digest &&
      +new Date(job.expires_at) > Date.now();
    try {
      await authorizeCrawler(tx, { id: job.actor_id, role: '' }, s.website_id, 'control');
    } catch (error) {
      if (!(error instanceof LiekanError) || ![401, 403, 404].includes(error.status)) throw error;
      valid = false;
    }
    if (!valid) {
      await tx.execute(
        "UPDATE liekan_robots_deployment SET state='conflict',error_code='context-or-file-changed' WHERE id=$1::uuid",
        job.id,
      );
      return { ack, job: null };
    }
    await tx.execute(
      "UPDATE liekan_robots_deployment SET state='leased',lease_until=now()+interval '60 seconds' WHERE id=$1::uuid",
      job.id,
    );
    return {
      ack,
      job: {
        id: job.id,
        expectedHash: job.expected_hash,
        targetHash: job.target_hash,
        content: job.content,
        expiresAt: new Date(Date.now() + 45000).toISOString(),
      },
    };
  });
}

export async function processRobotsManagement() {
  await crawlerTransaction(async tx => {
    await tx.execute(
      "UPDATE liekan_robots_deployment SET state='unknown',error_code='receipt-missing' WHERE state='leased' AND lease_until<now()",
    );
    await tx.execute(
      "UPDATE liekan_robots_deployment SET state='cancelled',error_code='preview-expired' WHERE state='queued' AND expires_at<now()",
    );
  });
  // Lock order stays state -> deployment across browser, helper and worker operations.
  const task = await crawlerTransaction(async tx => {
    const [s] = await tx.query(
      `SELECT s.* FROM liekan_robots_state s WHERE (checking_until IS NULL OR checking_until<now()) AND ((monitor AND next_check<=now()) OR EXISTS(SELECT 1 FROM liekan_robots_deployment d WHERE d.website_id=s.website_id AND d.state='applied' AND d.verify_after<=now())) ORDER BY next_check LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (!s) return null;
    const lease = randomUUID();
    await tx.execute(
      "UPDATE liekan_robots_state SET check_lease=$2::uuid,checking_until=now()+interval '60 seconds',next_check=now()+interval '1 minute'*interval_minutes WHERE website_id=$1::uuid",
      s.website_id,
      lease,
    );
    const [job] = await tx.query(
      "SELECT * FROM liekan_robots_deployment WHERE website_id=$1::uuid AND state='applied' ORDER BY created_at LIMIT 1",
      s.website_id,
    );
    return {
      website_id: s.website_id as string,
      monitor_actor: s.monitor_actor as string,
      context: s.context as string,
      hostname: s.hostname as string,
      lease,
      job,
    };
  });
  if (!task) return;
  let result: { content: string | null; status: number } | null = null,
    errorCode: string | null = null;
  const actor = { id: task.job?.actor_id ?? task.monitor_actor, role: '' };
  const expectedContext = task.job?.context ?? task.context;
  const host = task.job?.hostname ?? task.hostname;
  try {
    await crawlerTransaction(async tx => {
      const site = await authorizeCrawler(tx, actor, task.website_id, 'control');
      if (contextOf(site) !== expectedContext) throw new LiekanError('网站归属或域名已变化', 409);
    });
    result = await probeRobots(task.website_id, host);
  } catch {
    errorCode = 'public-check-unavailable';
  }
  await crawlerTransaction(async tx => {
    const [s] = await tx.query(
      'SELECT * FROM liekan_robots_state WHERE website_id=$1::uuid FOR UPDATE',
      task.website_id,
    );
    if (!s || s.check_lease !== task.lease) return;
    try {
      const site = await authorizeCrawler(tx, actor, task.website_id, 'control');
      if (contextOf(site) !== expectedContext) throw new LiekanError('网站归属或域名已变化', 409);
    } catch {
      result = null;
      errorCode = 'authority-changed';
    }
    if (result) await recordProbe(tx, task.website_id, result.content, result.status, host);
    await tx.execute(
      "UPDATE liekan_robots_state SET checking_until=NULL,check_lease=NULL,last_error=$2,monitor=CASE WHEN $2='authority-changed' THEN false ELSE monitor END WHERE website_id=$1::uuid",
      task.website_id,
      errorCode,
    );
    if (task.job) {
      const verified = result && robotsDigest(result.content) === task.job.target_hash;
      const expired = +new Date(task.job.verify_deadline) <= Date.now();
      await tx.execute(
        "UPDATE liekan_robots_deployment SET state=$2,verified_at=CASE WHEN $2='verified' THEN now() ELSE NULL END,verify_after=now()+interval '30 seconds',error_code=$3 WHERE id=$1::uuid AND state='applied'",
        task.job.id,
        verified
          ? 'verified'
          : expired || errorCode === 'authority-changed'
            ? 'verification_failed'
            : 'applied',
        verified ? null : (errorCode ?? 'public-content-mismatch'),
      );
    }
  });
}
