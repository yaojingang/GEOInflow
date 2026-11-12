import { z } from 'zod';
import { logReadQuery } from '@/lib/liekan/contracts/log-read';
import { pageReportSchema } from '@/lib/liekan/contracts/page-report';
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
    path: '/api/liekan/websites/{websiteId}/log-entries',
    audience: 'public',
    auth: 'bearer',
    operation: {
      operationId: 'getLiekanLogEntries',
      summary: 'Read private log entries independently',
      tags: ['Liekan'],
      requestParams: { path: z.object({ websiteId: z.uuid() }), query: logReadQuery },
      responses: {
        '200': {
          description: 'Authorized log entries at the requested input boundary',
          content: { 'application/json': { schema: pageReportSchema } },
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
