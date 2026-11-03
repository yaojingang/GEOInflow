import { z } from 'zod';

export const CURRENT_BROWSER_IDENTITY_VERSION = 'cookieless-trusted-input-v4';

export const browserPopulationSchema = z.object({
  resourceId: z.string().optional(),
  populationVersion: z.string(),
  metricScope: z.literal('qualified-browser').optional(),
  resourceKind: z.enum(['website', 'link', 'pixel', 'unknown']),
  capability: z.enum(['supported', 'unsupported']),
  scope: z.literal('resource-window'),
  policyRevision: z.string().nullable(),
  historyActiveGeneration: z.string().nullable(),
  historyRevision: z.string().nullable(),
  epoch: z.string().nullable(),
  governanceRevision: z.string().nullable(),
  governanceWatermark: z.string().nullable(),
  governanceProcessing: z
    .object({
      state: z.enum(['observed', 'unknown']),
      computedAt: z.string().nullable(),
      nextWindow: z.string().nullable(),
      errorCode: z.string().nullable(),
    })
    .optional(),
  identity: z.object({
    status: z.enum(['complete', 'partial', 'unavailable', 'empty', 'unsupported']),
    eligibleEvents: z.number().int().nonnegative().nullable(),
    eligiblePV: z.number().int().nonnegative().nullable(),
    qualifiedPV: z.number().int().nonnegative().nullable(),
    qualifiedVisitors: z.number().int().nonnegative().nullable(),
    coverage: z.number().min(0).max(1).nullable(),
    versions: z.array(z.string()),
    qualifiedVersions: z.array(z.string()).optional(),
  }),
  ruleVersions: z.array(z.string()),
  catalogVersions: z.array(z.string()),
  versionSetsTruncated: z.boolean(),
  range: z.object({
    startAt: z.number(),
    endAt: z.number(),
    timezone: z.string(),
    endExclusive: z.boolean().optional(),
  }),
});
export type BrowserPopulation = z.infer<typeof browserPopulationSchema>;

export function identityEncodingChanged(population?: BrowserPopulation | null): boolean {
  const versions = population?.identity.qualifiedVersions || [];
  return (
    versions.includes(CURRENT_BROWSER_IDENTITY_VERSION) &&
    versions.some(version => version !== CURRENT_BROWSER_IDENTITY_VERSION)
  );
}

/** Cross-source comparisons require coverage of the complete browser population. */
export function identityComplete(population?: BrowserPopulation | null): boolean {
  return !population || ['complete', 'empty', 'unsupported'].includes(population.identity.status);
}

export function identityUsable(population?: BrowserPopulation | null): boolean {
  return (
    identityComplete(population) ||
    (population.metricScope === 'qualified-browser' &&
      population.identity.status === 'partial' &&
      (population.identity.qualifiedPV ?? 0) > 0)
  );
}

/** Known visitor-derived fields. Callers select fields from their own metric contract. */
export function unavailableFields<T extends Record<string, any>>(
  value: T,
  fields: readonly string[],
): T {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, fields.includes(key) ? null : entry]),
  ) as T;
}
export const totalIdentityFields = ['visitors', 'visits', 'bounces', 'totaltime'] as const;
