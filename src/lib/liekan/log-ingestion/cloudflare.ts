import { EDGE_FIELDS } from './edge-observation';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  LiekanError,
  query,
  sourceWebsite,
  transaction,
  type WriteIdentity,
} from '../upstream/server';
import {
  createSource,
  ensureState,
  publicUrl,
  uuid,
  activateSource,
  validateSource,
  type LogSource,
} from './service';
import { hostname } from './protocol';
import { newToken, tokenHash, sealPlatformSecret, openPlatformSecret } from './secrets';
import { enqueue, PROVIDER_QUEUE } from './queue';
import { getLogCapabilities } from './capabilities';
import { cloudflareRequest, cloudflareResponseError, cloudflareScopes } from './cloudflare-http';

const CF_API = 'https://api.cloudflare.com/client/v4';
const CF_AUTH = 'https://dash.cloudflare.com/oauth2';
const callbackUrl = () => `${publicUrl()}/api/liekan/oauth/cloudflare/callback`;
interface Access {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}
interface Provider extends Access {
  zoneId: string;
  receiverToken: string;
  remoteDisabled?: boolean;
  receiverOrigin?: string;
  receiverOrigins?: string[];
  crawlerFields?: string[];
  fieldCapabilities?: Record<string, boolean>;
}
interface Flow {
  phase: 'pending' | 'exchanging' | 'authorized';
  verifier: string;
  access?: Access;
  zones?: { id: string; name: string; status: string }[];
}
function cookieValue(request: Request, id: string) {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map(value => value.trim())
    .find(value => value.startsWith(`liekan_oauth_${id}=`))
    ?.split('=')[1];
}
export async function beginCloudflare(websiteId: string, identity: WriteIdentity) {
  const capability = (await getLogCapabilities()).cloudflare;
  if (!capability.available) throw new LiekanError(capability.reason, 503);
  const scope = cloudflareScopes();
  const state = newToken(),
    browser = newToken(),
    verifier = newToken(),
    flowId = randomUUID();
  await transaction(async tx => {
    const website = await sourceWebsite(tx, websiteId, identity),
      s = await ensureState(tx, websiteId);
    const count = (
      await tx.$queryRawUnsafe(
        "SELECT count(*)::int AS n FROM liekan_log_grant WHERE website_id=$1::uuid AND kind='oauth' AND expires_at>now() AND consumed_at IS NULL",
        websiteId,
      )
    )[0].n;
    if (count >= 5) throw new LiekanError('授权流程数量已达上限，请稍后再试', 429);
    await tx.$executeRawUnsafe(
      "INSERT INTO liekan_log_grant(id,website_id,created_by,domain,epoch,kind,secret_hash,browser_hash,payload,expires_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,'oauth',$6,$7,$8,now()+interval '10 minutes')",
      flowId,
      websiteId,
      identity.userId,
      hostname(website.domain),
      s.epoch,
      tokenHash(state),
      tokenHash(browser),
      sealPlatformSecret(JSON.stringify({ phase: 'pending', verifier }), flowId),
    );
  });
  const url = new URL(`${CF_AUTH}/auth`);
  url.search = new URLSearchParams({
    client_id: process.env.CLOUDFLARE_OAUTH_CLIENT_ID,
    redirect_uri: callbackUrl(),
    response_type: 'code',
    scope,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return {
    authorizationUrl: url.toString(),
    flowId,
    cookie: `liekan_oauth_${flowId}=${browser}; HttpOnly; Secure; SameSite=Lax; Path=/api/liekan; Max-Age=600`,
  };
}
async function exchangeToken(parameters: Record<string, string>): Promise<Access> {
  const basic = Buffer.from(
    `${encodeURIComponent(process.env.CLOUDFLARE_OAUTH_CLIENT_ID)}:${encodeURIComponent(process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET)}`,
  ).toString('base64');
  const response = await cloudflareRequest(
    `${CF_AUTH}/token`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(parameters),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    },
    'token',
  );
  const data = await response.json();
  if (
    typeof data.access_token !== 'string' ||
    data.access_token.length < 8 ||
    data.access_token.length > 8192 ||
    (data.token_type && String(data.token_type).toLowerCase() !== 'bearer')
  )
    throw new LiekanError('Cloudflare 授权响应无效', 502);
  return {
    accessToken: data.access_token,
    ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : {}),
    ...(Number.isFinite(data.expires_in)
      ? { expiresAt: Date.now() + Number(data.expires_in) * 1000 }
      : {}),
  };
}
async function revokeAccess(access: Access) {
  const basic = Buffer.from(
    `${encodeURIComponent(process.env.CLOUDFLARE_OAUTH_CLIENT_ID)}:${encodeURIComponent(process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET)}`,
  ).toString('base64');
  for (const [token, hint] of [
    [access.refreshToken, 'refresh_token'],
    [access.accessToken, 'access_token'],
  ]) {
    if (!token) continue;
    await cloudflareRequest(
      `${CF_AUTH}/revoke`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ token, token_type_hint: hint }),
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      },
      'revoke',
    );
  }
}
export async function cloudflareApi<T = any>(
  accessToken: string,
  path: string,
  method = 'GET',
  body?: object,
): Promise<T> {
  if (!/^\/(zones|oauth)\//.test(path) || path.includes('..'))
    throw new LiekanError('供应商接口无效');
  const url = `${CF_API}${path}`;
  const response = await cloudflareRequest(
    url,
    {
      method,
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    },
    'api',
  );
  const data = await response.json();
  if (!data.success) throw cloudflareResponseError(response, data, 'api', url);
  return data.result as T;
}
export async function matchingZones(access: Access, domain: string) {
  const zones: { id: string; name: string; status: string }[] = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await cloudflareApi<any[]>(access.accessToken, `/zones/?per_page=50&page=${page}`);
    for (const row of rows)
      if (
        /^[a-f0-9]{32}$/.test(row.id) &&
        row.status === 'active' &&
        (domain === row.name || domain.endsWith(`.${row.name}`))
      )
        zones.push({ id: row.id, name: row.name, status: row.status });
    if (rows.length < 50) break;
  }
  if (!zones.length) throw new LiekanError('当前授权下未找到匹配的网站域名，请检查域名与权限', 409);
  return zones.sort((a, b) => b.name.length - a.name.length);
}
export async function acceptCloudflareCallback(request: Request) {
  const url = new URL(request.url),
    state = url.searchParams.get('state'),
    code = url.searchParams.get('code');
  if (
    !state ||
    !/^[A-Za-z0-9_-]{43}$/.test(state) ||
    !code ||
    code.length > 4096 ||
    url.searchParams.has('error')
  )
    throw new LiekanError('授权未完成，请从网站设置重新开始');
  const claimed = await transaction(async tx => {
    const row = (
      await tx.$queryRawUnsafe(
        "SELECT * FROM liekan_log_grant WHERE secret_hash=$1 AND kind='oauth' FOR UPDATE",
        tokenHash(state),
      )
    )[0];
    if (
      !row ||
      !cookieValue(request, row.id) ||
      tokenHash(cookieValue(request, row.id)) !== row.browser_hash ||
      row.consumed_at ||
      +new Date(row.expires_at) <= Date.now()
    )
      throw new LiekanError('授权流程无效或已过期', 401);
    const flow: Flow = JSON.parse(openPlatformSecret(row.payload, row.id));
    if (flow.phase !== 'pending') throw new LiekanError('授权回调已使用', 409);
    flow.phase = 'exchanging';
    await tx.$executeRawUnsafe(
      'UPDATE liekan_log_grant SET payload=$2 WHERE id=$1::uuid',
      row.id,
      sealPlatformSecret(JSON.stringify(flow), row.id),
    );
    return { row, flow };
  });
  const access = await exchangeToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl(),
    code_verifier: claimed.flow.verifier,
  });
  let staged = false;
  try {
    const valid = await transaction(async tx => {
      const row = (
        await tx.$queryRawUnsafe(
          'SELECT * FROM liekan_log_grant WHERE id=$1::uuid FOR UPDATE',
          claimed.row.id,
        )
      )[0];
      const valid = row && !row.consumed_at && +new Date(row.expires_at) > Date.now();
      await tx.$executeRawUnsafe(
        'INSERT INTO liekan_oauth_cleanup(id,website_id,payload,expires_at) VALUES($1::uuid,$2::uuid,$3,$4) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,expires_at=EXCLUDED.expires_at,lease=NULL,lease_until=NULL,last_attempt_at=NULL',
        claimed.row.id,
        claimed.row.website_id,
        sealPlatformSecret(JSON.stringify({ access }), claimed.row.id),
        valid ? new Date(row.expires_at) : new Date(),
      );
      if (valid)
        await tx.$executeRawUnsafe(
          'UPDATE liekan_log_grant SET payload=$2 WHERE id=$1::uuid',
          row.id,
          sealPlatformSecret(JSON.stringify({ ...claimed.flow, access }), row.id),
        );
      return Boolean(valid);
    });
    staged = true;
    if (!valid) throw new LiekanError('授权流程已过期', 409);
    const zones = await matchingZones(access, claimed.row.domain);
    await transaction(async tx => {
      const row = (
        await tx.$queryRawUnsafe(
          'SELECT * FROM liekan_log_grant WHERE id=$1::uuid FOR UPDATE',
          claimed.row.id,
        )
      )[0];
      if (!row || row.consumed_at || +new Date(row.expires_at) <= Date.now())
        throw new LiekanError('授权流程已过期', 409);
      await tx.$executeRawUnsafe(
        'UPDATE liekan_log_grant SET payload=$2 WHERE id=$1::uuid',
        row.id,
        sealPlatformSecret(
          JSON.stringify({ phase: 'authorized', verifier: '', access, zones }),
          row.id,
        ),
      );
    });
  } catch (error) {
    if (staged)
      await transaction(async tx => {
        await tx.$executeRawUnsafe(
          'UPDATE liekan_log_grant SET expires_at=clock_timestamp() WHERE id=$1::uuid',
          claimed.row.id,
        );
        await tx.$executeRawUnsafe(
          'UPDATE liekan_oauth_cleanup SET expires_at=clock_timestamp() WHERE id=$1::uuid',
          claimed.row.id,
        );
      });
    else await revokeAccess(access).catch(() => {});
    throw error;
  }
  return `${publicUrl()}/websites/${claimed.row.website_id}/settings?section=install&step=logs&method=cloudflare&flow=${claimed.row.id}`;
}
export async function cleanupExpiredAuthorizations(workerId: string) {
  const rows = await query(
    "SELECT id FROM liekan_oauth_cleanup WHERE expires_at<=now() AND (lease_until IS NULL OR lease_until<now()) AND (last_attempt_at IS NULL OR last_attempt_at<now()-interval '30 seconds') ORDER BY last_attempt_at NULLS FIRST,expires_at LIMIT 10",
  );
  for (const row of rows) {
    const claimed = await transaction<any[]>(tx =>
      tx.$queryRawUnsafe(
        "UPDATE liekan_oauth_cleanup SET lease=$2::uuid,lease_until=now()+interval '5 minutes',last_attempt_at=now() WHERE id=$1::uuid AND expires_at<=now() AND (lease_until IS NULL OR lease_until<now()) RETURNING payload",
        row.id,
        workerId,
      ),
    );
    if (!claimed.length) continue;
    try {
      const stored = JSON.parse(openPlatformSecret(claimed[0].payload, row.id));
      if (stored.access) await revokeAccess(stored.access);
      await transaction(tx =>
        tx.$executeRawUnsafe(
          'DELETE FROM liekan_oauth_cleanup WHERE id=$1::uuid AND lease=$2::uuid',
          row.id,
          workerId,
        ),
      );
    } catch {
      // Keep encrypted credentials for the next bounded retry.
    } finally {
      await transaction(tx =>
        tx.$executeRawUnsafe(
          'UPDATE liekan_oauth_cleanup SET lease=NULL,lease_until=NULL WHERE id=$1::uuid AND lease=$2::uuid',
          row.id,
          workerId,
        ),
      );
    }
  }
}
export async function finalizeCloudflare(
  websiteId: string,
  input: unknown,
  identity: WriteIdentity,
  request: Request,
) {
  const parsed = z
    .strictObject({
      flowId: z.uuid(),
      zoneId: z
        .string()
        .regex(/^[a-f0-9]{32}$/)
        .optional(),
      acceptCosts: z.boolean().optional(),
    })
    .safeParse(input);
  if (!parsed.success) throw new LiekanError('授权确认格式无效');
  const { flowId, zoneId, acceptCosts } = parsed.data;
  return transaction(async tx => {
    const website = await sourceWebsite(tx, websiteId, identity),
      state = await ensureState(tx, websiteId);
    const row = (
      await tx.$queryRawUnsafe(
        "SELECT * FROM liekan_log_grant WHERE id=$1::uuid AND website_id=$2::uuid AND kind='oauth' FOR UPDATE",
        flowId,
        websiteId,
      )
    )[0];
    if (
      !row ||
      row.created_by !== identity.userId ||
      +new Date(row.expires_at) <= Date.now() ||
      row.epoch !== state.epoch ||
      hostname(website.domain) !== row.domain ||
      !cookieValue(request, flowId) ||
      tokenHash(cookieValue(request, flowId)) !== row.browser_hash
    )
      throw new LiekanError('授权身份或网站配置已变更，请重新授权', 403);
    if (row.consumed_at && row.source_id) return { sourceId: row.source_id, state: 'configuring' };
    const flow: Flow = JSON.parse(openPlatformSecret(row.payload, flowId));
    if (flow.phase !== 'authorized') throw new LiekanError('请先完成 Cloudflare 授权', 409);
    if (!zoneId) return { domain: row.domain, zones: flow.zones };
    if (!acceptCosts || !flow.zones.some(zone => zone.id === zoneId))
      throw new LiekanError('请确认匹配域名及供应商费用提示');
    const { source, token } = await createSource(tx, websiteId, 'cloudflare', identity);
    const cleanup = (
      await tx.$queryRawUnsafe(
        'SELECT id FROM liekan_oauth_cleanup WHERE id=$1::uuid AND lease IS NULL FOR UPDATE',
        flowId,
      )
    )[0];
    if (!cleanup || +new Date(row.expires_at) <= Date.now())
      throw new LiekanError('授权流程已过期', 409);
    const config: Provider = {
      ...flow.access,
      zoneId,
      receiverToken: token,
      receiverOrigin: publicUrl(),
    };
    await tx.$executeRawUnsafe(
      'UPDATE liekan_log_source SET provider_config=$2 WHERE id=$1::uuid',
      source.id,
      sealPlatformSecret(JSON.stringify(config), source.id),
    );
    await tx.$executeRawUnsafe('DELETE FROM liekan_oauth_cleanup WHERE id=$1::uuid', flowId);
    await tx.$executeRawUnsafe(
      'UPDATE liekan_log_grant SET consumed_at=now(),source_id=$2::uuid,payload=NULL WHERE id=$1::uuid',
      flowId,
      source.id,
    );
    await enqueue(tx, PROVIDER_QUEUE, { sourceId: source.id, action: 'configure' });
    return { sourceId: source.id, state: 'configuring' };
  });
}
export function logpushConfiguration(source: LogSource, config: Provider, epoch: number) {
  const destination = `${publicUrl()}/api/liekan/log-sources/${source.id}/batches?header_Authorization=${encodeURIComponent(`Bearer ${config.receiverToken}`)}&header_X-Liekan-Epoch=${epoch}`;
  return {
    name: `liekan-${source.id}`,
    dataset: 'http_requests',
    enabled: false,
    destination_conf: destination,
    filter: JSON.stringify({
      where: {
        and: [
          { key: 'ClientRequestHost', operator: 'eq', value: source.domain },
          { key: 'ClientRequestSource', operator: 'eq', value: 'eyeball' },
        ],
      },
    }),
    output_options: {
      field_names: [
        'ClientIP',
        'ClientRequestHost',
        'ClientRequestMethod',
        'ClientRequestURI',
        'ClientRequestUserAgent',
        'EdgeStartTimestamp',
        'EdgeEndTimestamp',
        'EdgeResponseStatus',
        'EdgeResponseBodyBytes',
        'RayID',
        'ClientRequestSource',
        ...(config.crawlerFields || []),
      ],
      timestamp_format: 'rfc3339ns',
      sample_rate: 1,
    },
    max_upload_bytes: 5000000,
    max_upload_records: 1000,
  };
}
export function observedLogpushMeasurement(
  job: any,
  definition: ReturnType<typeof logpushConfiguration>,
) {
  // A successful read of the complete provider configuration is the only sampling proof.
  if (
    !job ||
    job.dataset !== definition.dataset ||
    job.filter !== definition.filter ||
    job.output_options?.sample_rate !== 1 ||
    job.output_options?.timestamp_format !== 'rfc3339ns' ||
    !Array.isArray(job.output_options?.field_names) ||
    !definition.output_options.field_names.every(field =>
      job.output_options.field_names.includes(field),
    )
  )
    return null;
  return {
    version: createHash('sha256')
      .update(JSON.stringify({ filter: job.filter, output: job.output_options }))
      .digest('hex'),
    observedAt: new Date().toISOString(),
    samplingRate: 1,
  };
}
function ownsDestination(destination: string, source: LogSource, config: Provider) {
  try {
    const url = new URL(destination);
    return (
      url.protocol === 'https:' &&
      (!config.receiverOrigin ||
        url.origin === config.receiverOrigin ||
        config.receiverOrigins?.includes(url.origin) ||
        url.origin === publicUrl()) &&
      url.pathname === `/api/liekan/log-sources/${source.id}/batches` &&
      url.searchParams.get('header_Authorization') === `Bearer ${config.receiverToken}`
    );
  } catch {
    return false;
  }
}
export async function maintainCloudflare(
  sourceId: string,
  action: 'configure' | 'disconnect' | 'health',
) {
  const row: LogSource = (
    await query('SELECT * FROM liekan_log_source WHERE id=$1::uuid', uuid(sourceId))
  )[0];
  if (!row?.provider_config) return;
  let config: Provider = JSON.parse(openPlatformSecret(row.provider_config, row.id));
  if (
    !config.remoteDisabled &&
    config.expiresAt &&
    config.expiresAt < Date.now() + 60000 &&
    config.refreshToken
  ) {
    const refreshed = await exchangeToken({
      grant_type: 'refresh_token',
      refresh_token: config.refreshToken,
    });
    config = { ...config, ...refreshed };
    await transaction(tx =>
      tx.$executeRawUnsafe(
        'UPDATE liekan_log_source SET provider_config=$2 WHERE id=$1::uuid',
        row.id,
        sealPlatformSecret(JSON.stringify(config), row.id),
      ),
    );
  }
  if (action === 'disconnect' || row.state === 'disconnected') {
    if (!config.remoteDisabled && row.provider_job_id) {
      const jobs = await cloudflareApi<any[]>(
        config.accessToken,
        `/zones/${config.zoneId}/logpush/jobs`,
      );
      const owned = jobs.find(
        job =>
          String(job.id) === row.provider_job_id &&
          job.name === `liekan-${row.id}` &&
          job.dataset === 'http_requests' &&
          ownsDestination(job.destination_conf, row, config),
      );
      if (owned)
        await cloudflareApi(
          config.accessToken,
          `/zones/${config.zoneId}/logpush/jobs/${owned.id}`,
          'PUT',
          { enabled: false },
        );
    }
    if (!config.remoteDisabled) {
      config.remoteDisabled = true;
      await transaction(tx =>
        tx.$executeRawUnsafe(
          'UPDATE liekan_log_source SET provider_config=$2 WHERE id=$1::uuid',
          row.id,
          sealPlatformSecret(JSON.stringify(config), row.id),
        ),
      );
    }
    await revokeAccess(config);
    await transaction(tx =>
      tx.$executeRawUnsafe(
        'UPDATE liekan_log_source SET provider_config=NULL WHERE id=$1::uuid',
        row.id,
      ),
    );
    return;
  }
  if (config.expiresAt && config.expiresAt < Date.now() && !config.refreshToken)
    throw new LiekanError('授权已过期，请重新授权', 401);
  const live = await transaction(tx => validateSource(tx, row.id, undefined, true));
  if (action === 'configure' && config.crawlerFields === undefined) {
    const fields = await cloudflareApi<Record<string, unknown>>(
      config.accessToken,
      `/zones/${config.zoneId}/logpush/datasets/http_requests/fields`,
    ).catch(() => null);
    config.fieldCapabilities = fields
      ? Object.fromEntries(EDGE_FIELDS.map(field => [field, Object.hasOwn(fields, field)]))
      : undefined;
    config.crawlerFields = [
      'SecurityAction',
      'SecurityRuleID',
      'SecurityRuleIDs',
      'CacheCacheStatus',
      ...EDGE_FIELDS,
    ].filter(field => fields && Object.hasOwn(fields, field));
    await transaction(tx =>
      tx.$executeRawUnsafe(
        'UPDATE liekan_log_source SET provider_config=$2 WHERE id=$1::uuid',
        row.id,
        sealPlatformSecret(JSON.stringify(config), row.id),
      ),
    );
  }
  const jobs = await cloudflareApi<any[]>(
    config.accessToken,
    `/zones/${config.zoneId}/logpush/jobs`,
  );
  const definition = logpushConfiguration(row, config, live.epoch);
  const owned = jobs.filter(
    job =>
      job.name === definition.name &&
      job.dataset === 'http_requests' &&
      ownsDestination(job.destination_conf, row, config),
  );
  if (owned.length > 1) throw new LiekanError('发现重复推送任务，需要重新连接', 409);
  let job = owned[0];
  const origin = publicUrl();
  if (config.receiverOrigin !== origin) {
    // Preserve observed legacy destinations and persist ownership before updating the provider.
    config.receiverOrigins = [
      ...new Set([
        ...(config.receiverOrigins || []),
        ...(config.receiverOrigin ? [config.receiverOrigin] : []),
        ...(job ? [new URL(job.destination_conf).origin] : []),
        origin,
      ]),
    ];
    config.receiverOrigin = origin;
    await transaction(tx =>
      tx.$executeRawUnsafe(
        'UPDATE liekan_log_source SET provider_config=$2 WHERE id=$1::uuid',
        row.id,
        sealPlatformSecret(JSON.stringify(config), row.id),
      ),
    );
  }
  if (!job && row.provider_job_id) {
    // A reset changes the epoch header; identify the recorded job before replacing its config.
    job = jobs.find(
      job =>
        String(job.id) === row.provider_job_id &&
        job.name === definition.name &&
        job.dataset === 'http_requests' &&
        ownsDestination(job.destination_conf, row, config),
    );
    if (job) {
      await cloudflareApi(
        config.accessToken,
        `/zones/${config.zoneId}/logpush/jobs/${job.id}`,
        'PUT',
        { ...definition, enabled: row.state === 'active' },
      );
    }
  }
  if (
    (action === 'health' || row.state === 'active' || row.state === 'paused') &&
    row.state !== 'configuring'
  ) {
    if (!job) throw new LiekanError('Cloudflare 推送任务不存在，请重新授权', 409);
    const shouldEnable = row.state === 'active';
    if (!!job.enabled !== shouldEnable) {
      await cloudflareApi(
        config.accessToken,
        `/zones/${config.zoneId}/logpush/jobs/${job.id}`,
        'PUT',
        { enabled: shouldEnable },
      );
      job.enabled = shouldEnable;
    }
    if (job.destination_conf !== definition.destination_conf)
      await cloudflareApi(
        config.accessToken,
        `/zones/${config.zoneId}/logpush/jobs/${job.id}`,
        'PUT',
        { ...definition, enabled: shouldEnable },
      );
    await transaction(async tx => {
      await validateSource(tx, row.id, undefined, true);
      await tx.$executeRawUnsafe(
        'UPDATE liekan_log_source SET last_heartbeat_at=now(),health=$2::jsonb,error_code=$3 WHERE id=$1::uuid',
        row.id,
        JSON.stringify({
          providerEnabled: !!job.enabled,
          lastComplete: job.last_complete || null,
          measurement: observedLogpushMeasurement(job, definition),
          fieldCapabilities: config.fieldCapabilities,
        }),
        job.last_error &&
          (!job.last_complete || +new Date(job.last_error) > +new Date(job.last_complete))
          ? 'provider-delivery-error'
          : null,
      );
    });
    return;
  }
  if (!job)
    job = await cloudflareApi(
      config.accessToken,
      `/zones/${config.zoneId}/logpush/jobs`,
      'POST',
      definition,
    );
  else
    await cloudflareApi(
      config.accessToken,
      `/zones/${config.zoneId}/logpush/jobs/${job.id}`,
      'PUT',
      definition,
    );
  await transaction(async tx => {
    // Record the disabled owned job before checking a concurrent policy change.
    await tx.$executeRawUnsafe(
      'UPDATE liekan_log_source SET provider_job_id=$2 WHERE id=$1::uuid',
      row.id,
      String(job.id),
    );
  });
  await transaction(async tx => {
    const current = await validateSource(tx, row.id, undefined, true);
    const state = await ensureState(tx, row.website_id);
    if (
      current.source.state !== 'configuring' ||
      String(state.policy_revision) !== String(current.source.requested_policy_revision)
    )
      throw new LiekanError('主要来源已变更，请重新确认此连接', 409);
  });
  await cloudflareApi(config.accessToken, `/zones/${config.zoneId}/logpush/jobs/${job.id}`, 'PUT', {
    enabled: true,
  });
  try {
    await transaction(async tx => {
      const checked = await validateSource(tx, row.id, undefined, true);
      if (checked.epoch !== live.epoch) throw new LiekanError('采集代次已改变，请重试', 409);
      await activateSource(tx, checked.source);
      await tx.$executeRawUnsafe(
        'UPDATE liekan_log_source SET last_heartbeat_at=now() WHERE id=$1::uuid',
        row.id,
      );
    });
  } catch (error) {
    // A domain, permission or primary-source change can race a provider request.
    await cloudflareApi(
      config.accessToken,
      `/zones/${config.zoneId}/logpush/jobs/${job.id}`,
      'PUT',
      { enabled: false },
    ).catch(() => {});
    throw error;
  }
}
