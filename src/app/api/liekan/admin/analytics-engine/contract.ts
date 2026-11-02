import { z } from 'zod';
import {
  analyticsEngineActionSchema,
  analyticsEngineStatusSchema,
} from '@/lib/liekan/contracts/analytics-engine';
import { defineOperation } from '@/openapi/operation';
import { badRequestResponse, forbiddenResponse, unauthorizedResponse } from '@/openapi/schemas';

const responses = {
  '200': {
    description: 'System analytics engine state; complete administrator session required',
    content: { 'application/json': { schema: analyticsEngineStatusSchema } },
  },
  '400': badRequestResponse,
  '401': unauthorizedResponse,
  '403': forbiddenResponse,
  '409': { description: 'State changed or preparation and verification are required' },
  '503': { description: 'The configured analytics service or background worker is unavailable' },
};
export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/liekan/admin/analytics-engine',
    audience: 'internal',
    auth: 'bearer',
    operation: {
      operationId: 'getLiekanAnalyticsEngine',
      summary: 'Read optional analytics engine state (administrator session)',
      tags: ['Liekan'],
      requestParams: { query: z.object({ cursor: z.uuid().optional() }) },
      responses,
    },
  }),
  defineOperation({
    method: 'post',
    path: '/api/liekan/admin/analytics-engine',
    audience: 'internal',
    auth: 'bearer',
    operation: {
      operationId: 'changeLiekanAnalyticsEngine',
      summary: 'Manage optional historical log analytics (administrator session)',
      tags: ['Liekan'],
      requestBody: { content: { 'application/json': { schema: analyticsEngineActionSchema } } },
      responses,
    },
  }),
] as const;
