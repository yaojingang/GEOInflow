import { z } from 'zod';
import { logCountQuery, logSummarySchema } from '@/lib/liekan/contracts/log-read';
import {
  apiErrorSchema,
  badRequestResponse,
  defineOperation,
  notFoundResponse,
  unauthorizedResponse,
} from '@/lib/liekan/upstream/feature-api-contracts';

export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/liekan/websites/{websiteId}/log-summary',
    audience: 'public',
    auth: 'bearer',
    operation: {
      operationId: 'getLiekanLogSummary',
      summary: 'Read private log summary independently',
      tags: ['Liekan'],
      requestParams: { path: z.object({ websiteId: z.uuid() }), query: logCountQuery },
      responses: {
        '200': {
          description: 'Authorized log summary at the requested input boundary',
          content: { 'application/json': { schema: logSummarySchema } },
        },
        '400': badRequestResponse,
        '401': unauthorizedResponse,
        '404': notFoundResponse,
        '409': {
          description: 'Log input boundary changed; read entries again',
          content: { 'application/json': { schema: apiErrorSchema } },
        },
      },
    },
  }),
] as const;
