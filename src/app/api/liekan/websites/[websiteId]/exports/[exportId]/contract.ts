import { z } from 'zod';
import {
  defineOperation,
  unauthorizedResponse,
  notFoundResponse,
  apiErrorSchema,
} from '@/lib/liekan/upstream/feature-api-contracts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: apiErrorSchema } },
});
const file = { schema: z.string().meta({ format: 'binary' }) };

export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/liekan/websites/{websiteId}/exports/{exportId}',
    audience: 'public',
    auth: 'bearer',
    operation: {
      operationId: 'downloadLiekanExport',
      summary: '下载已生成的网站统计文件',
      description:
        '使用创建导出时返回的 downloadUrl 流式下载 CSV、JSON 或 ZIP。仅创建者在仍有网站权限时可下载；支持完整登录或 API key，拒绝公开分享身份。浏览器可使用创建接口设置的路径专用 HttpOnly 凭据 cookie。传输期间继续复核权限和数据规则；权限或规则变化会中止传输。过期文件需要重新生成。',
      tags: ['Liekan'],
      requestParams: { path: z.object({ websiteId: z.uuid(), exportId: z.uuid() }) },
      responses: {
        200: {
          description: '按块传输完整文件；文件名和字节数由响应头提供',
          headers: {
            'Content-Disposition': { schema: z.string() },
            'Content-Length': { schema: z.string() },
          },
          content: { 'text/csv': file, 'application/json': file, 'application/zip': file },
        },
        401: unauthorizedResponse,
        403: error('当前账户无网站访问权限'),
        404: notFoundResponse,
        409: error('数据规则已变更，需要重新生成文件'),
        410: error('导出文件已过期'),
        503: error('存储或控制状态暂时不可用'),
      },
    },
  }),
] as const;
