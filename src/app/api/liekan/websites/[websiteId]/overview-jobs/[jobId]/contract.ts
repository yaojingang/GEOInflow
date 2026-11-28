import { z } from 'zod';
import { analysisJobSchema } from '@/lib/liekan/contracts/analysis-acceleration';
import { pageReportSchema } from '@/lib/liekan/contracts/page-report';
import { reportPreparingSchema } from '@/lib/liekan/contracts/report-status';
import { reportQuery, reportVersionSchema } from '@/lib/liekan/contracts/query';
import { defineOperation, apiErrorSchema } from '@/lib/liekan/upstream/feature-api-contracts';
const path = z.object({ websiteId: z.union([z.uuid(), z.string().regex(/^\d{1,9}$/)]), jobId: z.uuid() });
const resultQuery = reportQuery
  .partial()
  .extend({
    reportVersion: reportVersionSchema.optional(),
    overviewVersion: reportVersionSchema.optional(),
  });
const error = {
  description: 'Permission, report-version or background computation failure',
  content: { 'application/json': { schema: apiErrorSchema } },
};
const retention = z.array(
  z.object({
    date: z.string(),
    day: z.number(),
    visitors: z.number().nullable(),
    returnVisitors: z.number().nullable(),
    percentage: z.number().nullable(),
  }),
);
export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/liekan/websites/{websiteId}/overview-jobs/{jobId}',
    audience: 'public',
    auth: 'bearer',
    operation: {
      operationId: 'getLiekanOverviewJob',
      summary: 'Read the background report state without waiting for computation',
      tags: ['Liekan'],
      requestParams: { path },
      responses: {
        '200': {
          description: 'Current job state',
          content: { 'application/json': { schema: z.object({ analysisJob: analysisJobSchema }) } },
        },
        '400': error,
        '401': error,
        '403': error,
        '404': error,
        '410': error,
        '500': error,
      },
    },
  }),
  defineOperation({
    method: 'get',
    path: '/api/liekan/websites/{websiteId}/overview-jobs/{jobId}/result',
    audience: 'public',
    auth: 'bearer',
    operation: {
      operationId: 'getLiekanWebsitesWebsiteIdOverviewJobsJobIdResult',
      summary: 'Read a published report or a completed preparing response',
      tags: ['Liekan'],
      requestParams: { path, query: resultQuery },
      responses: {
        '200': {
          description: 'Published page or retention result at its stated data boundary',
          content: { 'application/json': { schema: z.union([pageReportSchema, retention]) } },
        },
        '202': {
          description: 'No published result yet; stop loading and offer a manual status read',
          content: { 'application/json': { schema: reportPreparingSchema } },
        },
        '400': error,
        '401': error,
        '403': error,
        '404': error,
        '409': error,
        '410': error,
        '500': error,
        '503': error,
      },
    },
  }),
] as const;
