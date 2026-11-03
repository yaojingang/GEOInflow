import { z } from 'zod';
import { defineOperation } from '@/openapi/operation';
import {
  badRequestResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
} from '@/openapi/schemas';
import {
  analysisAcceptedSchema,
  analysisWebsiteListSchema,
  analysisStatusSchema,
  analysisBuildSchema,
  analysisBuildInputSchema,
  analysisActionSchema,
} from '@/lib/liekan/contracts/analysis-acceleration';
export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/liekan/websites/{websiteId}/analytics-jobs/{jobId}',
    audience: 'public',
    auth: 'bearer',
    operation: {
      operationId: 'getLiekanAnalysisJob',
      summary:
        'Private statistics acceleration (complete session and current website authority required)',
      tags: ['Liekan'],
      requestParams: { path: z.object({ websiteId: z.uuid(), jobId: z.uuid() }) },
      responses: {
        '200': {
          description: 'Authorized acceleration state or the original registered query DTO',
          content: { 'application/json': { schema: analysisAcceptedSchema } },
        },
        '400': badRequestResponse,
        '401': unauthorizedResponse,
        '403': forbiddenResponse,
        '404': notFoundResponse,
        '409': { description: 'Revision or scope changed; reload current state' },
        '410': { description: 'The task or its result is expired or invalidated' },
        '429': { description: 'Per consumer, website, global admission or refresh limit reached' },
        '501': { description: 'PostgreSQL support required' },
        '503': { description: 'Bounded work failed or background capacity is unavailable' },
      },
    },
  }),
  defineOperation({
    method: 'delete',
    path: '/api/liekan/websites/{websiteId}/analytics-jobs/{jobId}',
    audience: 'public',
    auth: 'bearer',
    operation: {
      operationId: 'releaseLiekanAnalysisViewer',
      summary: 'Release this private browser read without cancelling other viewers',
      tags: ['Liekan'],
      requestParams: {
        path: z.object({ websiteId: z.uuid(), jobId: z.uuid() }),
        header: z.object({ 'X-Liekan-View': z.uuid() }),
      },
      responses: {
        '200': {
          description: 'The current viewer lease has been released',
          content: { 'application/json': { schema: z.object({ released: z.literal(true) }) } },
        },
        '400': badRequestResponse,
        '401': unauthorizedResponse,
        '403': forbiddenResponse,
        '404': notFoundResponse,
        '501': { description: 'PostgreSQL support required' },
      },
    },
  }),
] as const;
