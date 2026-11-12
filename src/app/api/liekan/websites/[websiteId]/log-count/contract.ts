import { z } from 'zod';
import { analysisAcceptedSchema } from '@/lib/liekan/contracts/analysis-acceleration';
import { logCountQuery, logCountSchema } from '@/lib/liekan/contracts/log-read';
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
    path: '/api/liekan/websites/{websiteId}/log-count',
    audience: 'public',
    auth: 'bearer',
    operation: {
      operationId: 'getLiekanLogCount',
      summary: 'Read private log count independently',
      tags: ['Liekan'],
      requestParams: { path: z.object({ websiteId: z.uuid() }), query: logCountQuery },
      responses: {
        '200': {
          description: 'Authorized log count at the requested input boundary',
          content: { 'application/json': { schema: logCountSchema } },
        },
        '202': {
          description: 'Exact count accepted as a private durable task',
          content: { 'application/json': { schema: analysisAcceptedSchema } },
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
