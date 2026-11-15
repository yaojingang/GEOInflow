import { analysisAcceptedSchema } from '@/lib/liekan/contracts/analysis-acceleration';
import { reportPreparingSchema } from '@/lib/liekan/contracts/report-status';
import { z } from 'zod';
import { overviewVersionSchema, reportQuery } from '@/lib/liekan/contracts/query';
import { pageReportSchema } from '@/lib/liekan/contracts/page-report';
import {
  defineOperation,
  apiErrorSchema,
  badRequestResponse,
  notFoundResponse,
  unauthorizedResponse,
} from '@/lib/liekan/upstream/feature-api-contracts';

export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/liekan/websites/{websiteId}/page-report',
    audience: 'public',
    auth: 'bearer',
    operation: {
      operationId: 'getLiekanPageReport',
      summary: 'get selected Liekan page statistics',
      tags: ['Liekan'],
      requestParams: {
        path: z.object({ websiteId: z.uuid() }),
        query: reportQuery.extend({
          refresh: z.enum(['0', '1']).optional(),
          reportVersion: overviewVersionSchema.optional(),
          overviewVersion: overviewVersionSchema.optional(),
        }),
      },
      responses: {
        '202': {
          description: 'The report is being prepared in the background; this read is complete',
          content: {
            'application/json': {
              schema: z.union([reportPreparingSchema, analysisAcceptedSchema]),
            },
          },
        },
        '200': {
          description: 'Selected page statistics and freshness',
          content: { 'application/json': { schema: pageReportSchema } },
        },
        '400': badRequestResponse,
        '401': unauthorizedResponse,
        '404': notFoundResponse,
        '503': {
          description: 'Background computation failed and no valid result is available',
          content: { 'application/json': { schema: apiErrorSchema } },
        },
        '409': {
          description: 'The reporting revision or cursor scope changed; reload the report',
          content: { 'application/json': { schema: apiErrorSchema } },
        },
      },
    },
  }),
] as const;
