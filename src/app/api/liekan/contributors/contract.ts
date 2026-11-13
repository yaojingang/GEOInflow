import { z } from 'zod';
import { defineOperation } from '@/openapi/operation';

export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/liekan/contributors',
    audience: 'public',
    auth: 'none',
    operation: {
      operationId: 'getLiekanContributors',
      summary: 'Read public GEOInflow GitHub contributors',
      tags: ['Liekan'],
      responses: {
        '200': {
          description: 'GitHub contributor profiles in contribution order',
          content: {
            'application/json': {
              schema: z.object({
                contributors: z.array(
                  z.object({ login: z.string(), avatarUrl: z.url(), profileUrl: z.url() }),
                ),
              }),
            },
          },
        },
        '503': {
          description: 'GitHub data is temporarily unavailable',
          content: { 'application/json': { schema: z.object({ error: z.string() }) } },
        },
      },
    },
  }),
] as const;
