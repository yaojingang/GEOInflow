import { analysisJobSchema } from '@/lib/liekan/contracts/analysis-acceleration';
import { pageReportSchema } from '@/lib/liekan/contracts/page-report';
import { tablePageMax } from '@/lib/liekan/contracts/query';
import { defineOperation } from '@/openapi/operation';
import {
  apiErrorSchema,
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  serverErrorResponse,
  unauthorizedResponse,
} from '@/openapi/schemas';
import { z } from 'zod';

const path = z.object({
  websiteId: z.union([z.uuid(), z.string().regex(/^\d{1,9}$/)]),
  jobId: z.uuid(),
});
const jobResponse = z.object({ analysisJob: analysisJobSchema });
const catalogHeader = z.object({ 'X-Liekan-Catalog-Version': z.uuid().optional() });
const page = z.number().int().min(1).max(tablePageMax).optional();
const errors = {
  '400': badRequestResponse,
  '401': unauthorizedResponse,
  '403': forbiddenResponse,
  '404': notFoundResponse,
  '410': jsonResponse(apiErrorSchema, 'The task has expired or its reporting state has changed.'),
  '500': serverErrorResponse,
  '503': jsonResponse(apiErrorSchema, 'The catalog, result, or reporting service is unavailable.'),
};

export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/liekan/websites/{websiteId}/overview-jobs/{jobId}',
    audience: 'public',
    auth: 'bearer',
    operation: {
      operationId: 'getLiekanOverviewJob',
      summary: 'Get the status of a warehouse overview job',
      tags: ['Liekan'],
      requestParams: { path, header: catalogHeader },
      responses: {
        '200': jsonResponse(jobResponse, 'Current state of the authorized overview job.'),
        ...errors,
      },
    },
  }),
  defineOperation({
    method: 'get',
    path: '/api/liekan/websites/{websiteId}/overview-jobs/{jobId}/{result}',
    audience: 'public',
    auth: 'bearer',
    operation: {
      operationId: 'getLiekanWebsitesWebsiteIdOverviewJobsJobIdResult',
      summary: 'Read the published result of a warehouse overview job',
      tags: ['Liekan'],
      requestParams: {
        path: path.extend({ result: z.literal('result') }),
        query: z.object({ tp_topBody: page, tp_visitorTopBody: page }),
        header: catalogHeader,
      },
      responses: {
        '200': jsonResponse(pageReportSchema, 'Published overview report for the requested page.'),
        '202': {
          ...jsonResponse(jobResponse, 'The overview job is queued or running.'),
          headers: {
            'Retry-After': {
              description: 'Seconds to wait before retrying.',
              schema: { type: 'integer', minimum: 1 },
            },
          },
        },
        ...errors,
      },
    },
  }),
] as const;
