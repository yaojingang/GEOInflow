import { z } from 'zod';
import { defineOperation } from '@/openapi/operation';
import { robotsAgentInput } from '@/lib/liekan/contracts/robots-management';
export const operations = [
  defineOperation({
    method: 'post',
    path: '/api/liekan/robots-agent',
    audience: 'collect',
    auth: 'source-token',
    operation: {
      operationId: 'postLiekanRobotsAgent',
      summary:
        'Pair an explicitly authorized robots helper or exchange a pinned-file job and receipt',
      tags: ['Liekan'],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: robotsAgentInput } },
      },
      responses: {
        '200': {
          description: 'Robots helper result',
          content: {
            'application/json': {
              schema: z.union([
                z.object({
                  token: z.string(),
                  agentId: z.uuid(),
                  hostname: z.string(),
                  websiteId: z.uuid(),
                }),
                z.object({
                  ack: z.uuid().nullable(),
                  revoked: z.boolean().optional(),
                  job: z
                    .object({
                      id: z.uuid(),
                      expectedHash: z.string(),
                      targetHash: z.string(),
                      content: z.string().nullable(),
                      expiresAt: z.string(),
                    })
                    .nullable(),
                }),
              ]),
            },
          },
        },
        '401': { description: 'Expired pairing code or invalid helper credential' },
        '409': { description: 'Website, authority or active operation changed' },
      },
    },
  }),
] as const;
