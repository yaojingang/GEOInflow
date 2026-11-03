import { z } from 'zod';
import {
  storageActionSchema,
  storageRunSchema,
  storageSettingsSchema,
  storageStateSchema,
} from '@/lib/liekan/contracts/storage-retention';
import { defineOperation } from '@/openapi/operation';
import {
  badRequestResponse,
  forbiddenResponse,
  notFoundResponse,
  unauthorizedResponse,
} from '@/openapi/schemas';

const errors = {
  '400': badRequestResponse,
  '401': unauthorizedResponse,
  '403': forbiddenResponse,
  '404': notFoundResponse,
  '409': { description: 'The policy or resource scope changed' },
  '410': { description: 'The preview expired' },
};
export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/liekan/storage',
    audience: 'public',
    auth: 'bearer',
    operation: {
      operationId: 'getLiekanInstanceStorage',
      summary: 'Manage safe storage retention with a complete private session',
      tags: ['Liekan'],
      requestParams: { query: z.object({ runId: z.uuid().optional() }) },
      responses: {
        ...errors,
        '200': {
          description: 'Authorized storage state or operation',
          content: {
            'application/json': { schema: z.union([storageStateSchema, storageRunSchema]) },
          },
        },
      },
    },
  }),
  defineOperation({
    method: 'post',
    path: '/api/liekan/storage',
    audience: 'public',
    auth: 'bearer',
    operation: {
      operationId: 'changeLiekanInstanceStorage',
      summary: 'Manage safe storage retention with a complete private session',
      tags: ['Liekan'],
      requestParams: { query: z.object({ runId: z.uuid().optional() }) },
      requestBody: {
        required: true,
        content: { 'application/json': { schema: storageActionSchema } },
      },
      responses: {
        ...errors,
        '200': {
          description: 'Authorized storage state or operation',
          content: {
            'application/json': {
              schema: z.union([
                storageRunSchema,
                storageSettingsSchema.extend({ revision: z.number() }),
              ]),
            },
          },
        },
      },
    },
  }),
] as const;
