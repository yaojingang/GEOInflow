import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { serverPairingSchema } from '../contracts/installation';
import { LiekanError, sourceWebsite, transaction, type WriteIdentity } from '../upstream/server';
import { readAgentManifest, readDockerManifest } from './assets';
import { getLogCapabilities } from './capabilities';
import { dockerInstallCommand } from './docker-deployment';
import { hostname } from './protocol';
import { newToken, tokenHash } from './secrets';
import { createSource, ensureState, publicUrl } from './service';

export async function createPairing(
  websiteId: string,
  identity: WriteIdentity,
  input: unknown = {},
) {
  const parsed = serverPairingSchema.safeParse(input);
  if (!parsed.success) throw new LiekanError('安装方式无效');
  const runtime = parsed.data.runtime || 'systemd';
  const manual = parsed.data.manual === true;
  const capabilities = await getLogCapabilities();
  if (manual) {
    // The pre-built manual kit carries its own verified artifacts; only the
    // shared ingestion prerequisites gate the one-time pairing code.
    const states = new Map((capabilities.server.checks || []).map(check => [check.id, check]));
    const blocked = (
      [
        ['public-url', '管理员尚未配置公网 HTTPS 接收地址'],
        ['queue', '日志队列尚未初始化'],
        ['worker', '日志处理服务暂未就绪'],
      ] as const
    ).find(([id]) => states.get(id)?.state !== 'ready');
    if (blocked) throw new LiekanError(blocked[1], 503);
  } else {
    if (!capabilities.server.available) throw new LiekanError(capabilities.server.reason, 503);
    if (!capabilities.server.runtimes?.[runtime])
      throw new LiekanError('所选安装方式的部署包尚未准备完成', 503);
  }
  const url = publicUrl(),
    manifest = manual
      ? null
      : await (runtime === 'docker' ? readDockerManifest() : readAgentManifest()),
    code = newToken();
  await transaction(async tx => {
    const website = await sourceWebsite(tx, websiteId, identity),
      state = await ensureState(tx, websiteId);
    const recent = (
      await tx.$queryRawUnsafe(
        "SELECT count(*)::int AS count FROM liekan_log_grant WHERE website_id=$1::uuid AND kind='pairing' AND expires_at>now() AND consumed_at IS NULL",
        websiteId,
      )
    )[0];
    if (recent.count >= 5) throw new LiekanError('有效安装命令数量已达上限，请等待旧命令失效', 429);
    await tx.$executeRawUnsafe(
      "INSERT INTO liekan_log_grant(id,website_id,created_by,domain,epoch,kind,secret_hash,expires_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,'pairing',$6,now()+interval '10 minutes')",
      randomUUID(),
      websiteId,
      identity.userId,
      hostname(website.domain),
      state.epoch,
      tokenHash(code),
    );
  });
  if (manual)
    return {
      manual: true as const,
      websiteId,
      url,
      pairingCode: code,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
  if (!manifest) throw new LiekanError('所选安装方式的部署包尚未准备完成', 503);
  const command = `d=$(mktemp -d) && curl -fsSL --proto '=https' --tlsv1.2 '${url}/liekan-agent/install.sh' -o "$d/install.sh" && printf '%s  %s\\n' '${manifest.installerSha256}' "$d/install.sh" | sha256sum -c - && sudo sh "$d/install.sh" --url '${url}' --code '${code}'`;
  return {
    command:
      runtime === 'docker'
        ? dockerInstallCommand(url, websiteId, manifest.docker!.installerSha256, code)
        : command,
    runtime,
    ...(runtime === 'docker' ? { pairingCode: code } : {}),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    version: manifest.version,
  };
}
export async function exchangePairing(input: unknown) {
  const parsed = z
    .strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/), websiteId: z.uuid().optional() })
    .safeParse(input);
  if (!parsed.success) throw new LiekanError('配对码格式无效');
  return transaction(async tx => {
    const first = (
      await tx.$queryRawUnsafe(
        "SELECT * FROM liekan_log_grant WHERE secret_hash=$1 AND kind='pairing'",
        tokenHash(parsed.data.code),
      )
    )[0];
    if (!first) throw new LiekanError('安装命令无效或已过期', 401);
    if (parsed.data.websiteId && first.website_id !== parsed.data.websiteId)
      throw new LiekanError('配对码与当前部署的网站不一致', 409);
    const website = await sourceWebsite(tx, first.website_id, { userId: first.created_by });
    const grant = (
      await tx.$queryRawUnsafe(
        'SELECT * FROM liekan_log_grant WHERE id=$1::uuid FOR UPDATE',
        first.id,
      )
    )[0];
    const state = await ensureState(tx, grant.website_id);
    if (
      grant.consumed_at ||
      +new Date(grant.expires_at) <= Date.now() ||
      state.epoch !== grant.epoch ||
      hostname(website.domain) !== grant.domain
    )
      throw new LiekanError('安装命令已使用或网站配置已变更', 409);
    const { source, token } = await createSource(tx, grant.website_id, 'server', {
      userId: grant.created_by,
    });
    await tx.$executeRawUnsafe(
      'UPDATE liekan_log_grant SET consumed_at=now(),source_id=$2::uuid WHERE id=$1::uuid',
      grant.id,
      source.id,
    );
    return {
      version: 1,
      sourceId: source.id,
      token,
      epoch: state.epoch,
      domain: source.domain,
      websiteId: grant.website_id,
    };
  });
}
