import { z } from 'zod';

export const robotsContentSchema = z
  .string()
  .max(262144)
  .refine(value => new TextEncoder().encode(value).length <= 262144 && !value.includes('\0'));
export const robotsManagementInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('read') }),
  z.strictObject({
    action: z.literal('save'),
    content: robotsContentSchema,
    revision: z.number().int().positive(),
  }),
  z.strictObject({
    action: z.literal('monitor'),
    enabled: z.boolean(),
    interval: z.union([z.literal(15), z.literal(60), z.literal(360)]),
  }),
  z.strictObject({ action: z.literal('pair') }),
  z.strictObject({ action: z.literal('revoke') }),
  z.strictObject({ action: z.literal('preview'), rollbackOf: z.uuid().optional() }),
  z.strictObject({ action: z.literal('confirm'), id: z.uuid() }),
  z.strictObject({ action: z.literal('verify'), id: z.uuid() }),
  z.strictObject({ action: z.literal('reconcile'), id: z.uuid() }),
  z.strictObject({ action: z.literal('acknowledge') }),
]);
export const robotsAgentInput = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('pair'),
    code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    path: z
      .string()
      .max(4096)
      .regex(/^\/.*\/robots\.txt$/),
  }),
  z.strictObject({
    action: z.literal('poll'),
    content: robotsContentSchema.nullable(),
    receipt: z
      .strictObject({
        id: z.uuid(),
        state: z.enum(['applied', 'conflict', 'failed', 'unknown']),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .optional(),
  }),
]);
export type RobotsManagementInput = z.infer<typeof robotsManagementInput>;
export type RobotsAgentInput = z.infer<typeof robotsAgentInput>;
export interface RobotsDeployment {
  id: string;
  state: string;
  before_content: string | null;
  content: string | null;
  created_at: string;
  expires_at: string;
  rollback_of: string | null;
  error_code: string | null;
}
export interface RobotsManagement {
  hostname: string;
  draft: string;
  revision: number;
  monitor: boolean;
  interval: 15 | 60 | 360;
  checkedAt: string | null;
  observedContent: string | null;
  observedHostname: string | null;
  observedStatus: number | null;
  lastError: string | null;
  changePending: boolean;
  agent: { connected: boolean; seenAt: string | null; path: string | null; contextValid: boolean };
  permissions: { canDraft: boolean; canControl: boolean };
  snapshots: {
    id: string;
    content: string | null;
    hostname: string;
    status: number;
    created_at: string;
  }[];
  deployments: RobotsDeployment[];
}

const deploymentSchema = z.object({
  id: z.uuid(),
  state: z.string(),
  before_content: z.string().nullable(),
  content: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
  rollback_of: z.uuid().nullable(),
  error_code: z.string().nullable(),
});
export const robotsManagementResponse = z.object({
  hostname: z.string(),
  draft: z.string(),
  revision: z.number(),
  monitor: z.boolean(),
  interval: z.number(),
  checkedAt: z.string().nullable(),
  observedContent: z.string().nullable(),
  observedHostname: z.string().nullable(),
  observedStatus: z.number().nullable(),
  lastError: z.string().nullable(),
  changePending: z.boolean(),
  agent: z.object({
    connected: z.boolean(),
    seenAt: z.string().nullable(),
    path: z.string().nullable(),
    contextValid: z.boolean(),
  }),
  permissions: z.object({ canDraft: z.boolean(), canControl: z.boolean() }),
  snapshots: z.array(
    z.object({
      id: z.uuid(),
      content: z.string().nullable(),
      hostname: z.string(),
      status: z.number(),
      created_at: z.string(),
    }),
  ),
  deployments: z.array(deploymentSchema),
});
