import { websiteSummaryQuery, websiteSummarySchema } from '@/lib/liekan/contracts/website-summary';
import {
  defineOperation,
  badRequestResponse,
  notFoundResponse,
  unauthorizedResponse,
} from '@/lib/liekan/upstream/feature-api-contracts';

export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/liekan/websites/summary',
    audience: 'public',
    auth: 'bearer',
    operation: {
      operationId: 'getLiekanWebsiteSummary',
      summary: 'Read bounded website summaries',
      tags: ['Liekan'],
      requestParams: { query: websiteSummaryQuery },
      responses: {
        '200': {
          description: 'Website totals and installation state',
          content: { 'application/json': { schema: websiteSummarySchema } },
        },
        '202': {
          description: 'A site summary is preparing. Available rows retain their published cutoff.',
          content: { 'application/json': { schema: websiteSummarySchema } },
        },
        '400': badRequestResponse,
        '401': unauthorizedResponse,
        '404': notFoundResponse,
      },
    },
  }),
] as const;
