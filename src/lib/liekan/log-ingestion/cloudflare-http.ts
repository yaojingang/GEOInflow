import { LiekanError } from '../upstream/errors';

type Operation = 'token' | 'api' | 'revoke';
const networkMessage: Record<Operation, string> = {
  token: 'Cloudflare 授权服务暂时无法连接',
  api: 'Cloudflare 暂时无法连接',
  revoke: 'Cloudflare 授权撤销暂时无法连接',
};
const networkCodes = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
function networkDiagnostic(error: unknown) {
  const outer = record(error),
    cause = record(outer.cause);
  const name = ['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(String(outer.name))
    ? String(outer.name)
    : 'Error';
  const candidates = [
    cause.code,
    outer.code,
    ...(Array.isArray(cause.errors) ? cause.errors.slice(0, 4).map(item => record(item).code) : []),
  ];
  let code = candidates.find(value => typeof value === 'string' && networkCodes.has(value)) as
    | string
    | undefined;
  if (!code && name === 'TimeoutError') code = 'ETIMEDOUT';
  if (!code && name === 'AbortError') code = 'ABORT_ERR';
  if (!code && typeof cause.message === 'string' && cause.message.startsWith('unexpected redirect'))
    code = 'redirect-not-allowed';
  return { name, code: code || 'unknown-network-error' };
}

export function cloudflareScopes() {
  const configured =
    process.env.CLOUDFLARE_OAUTH_SCOPES?.trim() || 'zone.read logs.read logs.write';
  const scopes = [...new Set(configured.split(/\s+/))];
  if (
    configured.length > 4096 ||
    scopes.length > 64 ||
    scopes.some(scope => !/^[a-z0-9][a-z0-9._:-]*$/i.test(scope))
  )
    throw new LiekanError('Cloudflare OAuth 权限配置无效', 503, 'cloudflare-scope-config-invalid');
  return scopes.join(' ');
}

export function cloudflareResponseError(
  response: Response,
  payload: unknown,
  operation: Operation,
  url: string,
) {
  const data = record(payload);
  const errors = Array.isArray(data.errors) ? data.errors.slice(0, 8).map(record) : [];
  const codes = errors
    .map(error => error.code)
    .filter(
      (code): code is number =>
        Number.isSafeInteger(code) && Number(code) >= 0 && Number(code) < 10000000,
    );
  console.error('[liekan-cloudflare]', {
    operation,
    kind: 'http-error',
    status: response.status,
    codes,
  });
  if (response.status === 429 || response.status >= 500)
    return new LiekanError(networkMessage[operation], 503, 'provider-unavailable');
  const logpush = /\/zones\/[^/]+\/logpush\//.test(new URL(url).pathname);
  if (
    logpush &&
    errors.some(
      error =>
        error.code === 1004 &&
        typeof error.message === 'string' &&
        /logpush is not enabled/i.test(error.message),
    )
  )
    return new LiekanError(
      'Cloudflare 账户尚未启用所需的 Logpush 能力',
      403,
      'provider-not-entitled',
    );
  if (
    response.status === 401 ||
    codes.includes(10000) ||
    (operation === 'token' && ['invalid_grant', 'invalid_client'].includes(String(data.error)))
  )
    return new LiekanError('Cloudflare 授权已失效，请重新授权', 401, 'reauthorization-required');
  if (response.status === 403 || (operation === 'token' && data.error === 'invalid_scope'))
    return new LiekanError('Cloudflare 授权缺少所需权限', 403, 'provider-permission-denied');
  if (response.ok) return new LiekanError('Cloudflare 未接受日志配置，请检查权限和账户能力', 409);
  return new LiekanError(networkMessage[operation], 503, 'provider-unavailable');
}

export async function cloudflareRequest(url: string, init: RequestInit, operation: Operation) {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const cause = networkDiagnostic(error);
    console.error('[liekan-cloudflare]', { operation, kind: 'network-error', ...cause });
    throw Object.assign(new LiekanError(networkMessage[operation], 503, 'provider-unavailable'), {
      cause,
    });
  }
  if (!response.ok)
    throw cloudflareResponseError(
      response,
      await response.json().catch(() => null),
      operation,
      url,
    );
  return response;
}
