import { z } from 'zod';

export const storageHours = [1, 6, 24, 168, 720] as const;
const hours = z
  .number()
  .int()
  .refine(value => storageHours.includes(value as any));
export const storageSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  pressureEnabled: z.boolean(),
  timezone: z
    .string()
    .min(1)
    .max(80)
    .refine(value => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
  hour: z.number().int().min(0).max(23),
  generationHours: hours,
  completedHours: hours,
  wakeHours: hours,
});
export type StorageSettings = z.infer<typeof storageSettingsSchema>;
export const defaultStorageSettings: StorageSettings = {
  enabled: true,
  pressureEnabled: true,
  timezone: 'Asia/Shanghai',
  hour: 3,
  generationHours: 24,
  completedHours: 24,
  wakeHours: 1,
};
export const storageActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('policy'),
    settings: storageSettingsSchema,
    expectedRevision: z.number().int().min(0),
    requestId: z.uuid(),
  }),
  z.strictObject({
    action: z.literal('preview'),
    generationHours: hours.default(24),
    completedHours: hours.default(24),
    wakeHours: hours.default(1),
    requestId: z.uuid(),
  }),
  z.strictObject({ action: z.enum(['confirm', 'stop']), id: z.uuid(), requestId: z.uuid() }),
]);
export type StorageAction = z.infer<typeof storageActionSchema>;
export type StorageScope = { websiteId?: string; actorId: string; locale?: 'zh-CN' | 'en-US' };
export interface StorageRun {
  id: string;
  scope: 'website' | 'instance';
  websiteId: string | null;
  kind: 'manual' | 'scheduled' | 'pressure';
  status: 'preview' | 'queued' | 'running' | 'completed' | 'stopped' | 'failed';
  createdAt: string;
  expiresAt: string;
  startedAt: string | null;
  completedAt: string | null;
  candidateCount: number;
  protectedCount: number;
  estimatedBytes: string;
  rowsDeleted: string;
  generationsDeleted: number;
  jobsDeleted: number;
  releasedBytes: string;
  physicalBytesBefore: string | null;
  physicalBytesAfter: string | null;
  errorCode: string | null;
}
export interface StorageState {
  scope: 'website' | 'instance';
  websiteId: string | null;
  canManageQueues: boolean;
  policy: StorageSettings & { revision: number };
  capacity: {
    siteBytes: string;
    globalBytes: string;
    siteLimit: number;
    globalLimit: number;
  } | null;
  preview: {
    candidateCount: number;
    protectedCount: number;
    estimatedBytes: string;
    completedJobs: number;
  };
  runs: StorageRun[];
}

export const storageRunSchema = z.object({
  id: z.uuid(),
  scope: z.enum(['website', 'instance']),
  websiteId: z.uuid().nullable(),
  kind: z.enum(['manual', 'scheduled', 'pressure']),
  status: z.enum(['preview', 'queued', 'running', 'completed', 'stopped', 'failed']),
  createdAt: z.string(),
  expiresAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  candidateCount: z.number(),
  protectedCount: z.number(),
  estimatedBytes: z.string(),
  rowsDeleted: z.string(),
  generationsDeleted: z.number(),
  jobsDeleted: z.number(),
  releasedBytes: z.string(),
  errorCode: z.string().nullable(),
  physicalBytesBefore: z.string().nullable(),
  physicalBytesAfter: z.string().nullable(),
});
export const storageStateSchema = z.object({
  scope: z.enum(['website', 'instance']),
  websiteId: z.uuid().nullable(),
  canManageQueues: z.boolean(),
  policy: storageSettingsSchema.extend({ revision: z.number() }),
  capacity: z
    .object({
      siteBytes: z.string(),
      globalBytes: z.string(),
      siteLimit: z.number(),
      globalLimit: z.number(),
    })
    .nullable(),
  preview: z.object({
    candidateCount: z.number(),
    protectedCount: z.number(),
    estimatedBytes: z.string(),
    completedJobs: z.number(),
  }),
  runs: z.array(storageRunSchema),
});
