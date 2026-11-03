import { z } from 'zod';
import { checkAuth } from '@/lib/auth';
import { SHARE_CONTEXT_HEADER, SHARE_TOKEN_HEADER } from '@/lib/constants';
import { storageActionSchema } from '../contracts/storage-retention';
import { readLocaleCookie } from '../i18n/locale';
import { authorizeAnalysisManagement } from './analysis-acceleration-api';
import { LiekanError } from './errors';
import { readStorageRun, readStorageState, storageAction } from './storage-retention';

async function instanceActor(request: Request) {
  if (request.headers.has(SHARE_CONTEXT_HEADER) || request.headers.has(SHARE_TOKEN_HEADER))
    throw new LiekanError('请完成登录后管理存储清理', 401);
  const auth = await checkAuth(request);
  if (auth?.authType !== 'session' || !auth.user?.id || auth.user.deletedAt || auth.shareToken)
    throw new LiekanError('请完成登录后管理存储清理', 401);
  if (!['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (origin) {
      const url = new URL(request.url);
      const protocol = request.headers.get('x-forwarded-proto') ?? url.protocol.slice(0, -1);
      const authority = request.headers.get('host') ?? url.host;
      if (!['http', 'https'].includes(protocol) || /[\s,/\\@?#]/u.test(authority))
        throw new LiekanError('写入请求来源无效', 403);
      let expected: string;
      try {
        expected = new URL(`${protocol}://${authority}`).origin;
      } catch {
        throw new LiekanError('写入请求来源无效', 403);
      }
      if (origin !== expected) throw new LiekanError('写入请求来源无效', 403);
    }
  }
  return { id: auth.user.id, role: auth.user.role };
}

async function scope(request: Request, handle?: string) {
  if (handle && process.env.CLICKHOUSE_URL)
    throw new LiekanError('统计加速当前支持 PostgreSQL', 501, 'storage-unsupported');
  const actor = handle
    ? await authorizeAnalysisManagement(request, handle)
    : { actor: await instanceActor(request), websiteId: undefined };
  return {
    actorId: actor.actor.id,
    websiteId: actor.websiteId,
    locale: readLocaleCookie(request.headers.get('cookie') || '') || ('zh-CN' as const),
  };
}
export async function storageStateResponse(request: Request, handle?: string) {
  const runId = new URL(request.url).searchParams.get('runId');
  if (runId && !z.uuid().safeParse(runId).success)
    throw new LiekanError('清理操作标识无效', 400, 'storage-invalid-input');
  const access = await scope(request, handle);
  return runId ? readStorageRun(access, runId) : readStorageState(access);
}
export async function storageActionResponse(request: Request, input: unknown, handle?: string) {
  const parsed = storageActionSchema.safeParse(input);
  if (!parsed.success) throw new LiekanError('清理参数无效', 400, 'storage-invalid-input');
  return storageAction(await scope(request, handle), parsed.data);
}
