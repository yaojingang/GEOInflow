import { z } from 'zod';
import { exportRequestSchema } from '@/lib/liekan/contracts/exports';
import {
  defineOperation,
  badRequestResponse,
  unauthorizedResponse,
  notFoundResponse,
  apiErrorSchema,
} from '@/lib/liekan/upstream/feature-api-contracts';
export const operations = [
  defineOperation({
    method: 'post',
    path: '/api/liekan/websites/{websiteId}/exports',
    audience: 'public',
    auth: 'bearer',
    operation: {
      operationId: 'createLiekanExport',
      summary: '导出当前网站真实统计文件',
      description:
        '返回 NDJSON：progress 为文件生成进度，file 为文件元数据与字段清单，complete 为完成，error 为生成失败。ClickHouse 导出按块生成完整文件，file.downloadUrl 提供受权限保护的下载地址，不设总行数或总文件字节数的业务上限；取消请求会停止生成。兼容迁移期间旧 PG 引擎的 chunk Base64 传输。普通 CSV/JSON 使用 summary；ZIP 使用勾选范围；kind=source-keywords 的 CSV 包含全部筛选关键词、搜索引擎、读取时间与条件。',
      tags: ['Liekan'],
      requestParams: { path: z.object({ websiteId: z.uuid() }) },
      requestBody: {
        required: true,
        content: { 'application/json': { schema: exportRequestSchema } },
      },
      responses: {
        200: {
          description: '使用有界内存生成真实文件，返回进度与下载信息',
          content: { 'application/x-ndjson': { schema: z.string() } },
        },
        400: badRequestResponse,
        401: unauthorizedResponse,
        403: {
          description: '无权访问资源',
          content: { 'application/json': { schema: apiErrorSchema } },
        },
        404: notFoundResponse,
        501: {
          description: '当前数据引擎暂不支持',
          content: { 'application/json': { schema: apiErrorSchema } },
        },
        413: {
          description: '旧 PG 引擎兼容响应：超过其旧导出上限；ClickHouse 导出不使用此上限',
          content: { 'application/json': { schema: apiErrorSchema } },
        },
        503: {
          description: '存储或控制服务暂时不可用',
          content: { 'application/json': { schema: apiErrorSchema } },
        },
      },
    },
  }),
] as const;
