// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('keeps the installation defaults and permits a bounded capacity expansion', async () => {
  const { readAnalysisStorageLimits } = await import('./analysis-storage-limits');
  expect(readAnalysisStorageLimits({})).toEqual({
    siteLimit: 1024 ** 3,
    globalLimit: 8 * 1024 ** 3,
  });
  expect(
    readAnalysisStorageLimits({
      LIEKAN_ANALYSIS_SITE_LIMIT_MIB: '2048',
      LIEKAN_ANALYSIS_GLOBAL_LIMIT_MIB: '16384',
    }),
  ).toEqual({ siteLimit: 2 * 1024 ** 3, globalLimit: 16 * 1024 ** 3 });
});
it.each(['0', '-1', '1.5', 'Infinity', 'NaN', '9007199254740991', '32', '511'])(
  'rejects invalid site capacity %s',
  async value => {
    const { readAnalysisStorageLimits } = await import('./analysis-storage-limits');
    expect(() => readAnalysisStorageLimits({ LIEKAN_ANALYSIS_SITE_LIMIT_MIB: value })).toThrow(
      'LIEKAN_ANALYSIS_SITE_LIMIT_MIB',
    );
  },
);
it('rejects a global budget that cannot cover a site or the result reserve', async () => {
  const { readAnalysisStorageLimits } = await import('./analysis-storage-limits');
  for (const value of ['128', '512', '2047'])
    expect(() => readAnalysisStorageLimits({ LIEKAN_ANALYSIS_GLOBAL_LIMIT_MIB: value })).toThrow(
      'LIEKAN_ANALYSIS_GLOBAL_LIMIT_MIB',
    );
  expect(() =>
    readAnalysisStorageLimits({
      LIEKAN_ANALYSIS_SITE_LIMIT_MIB: '16384',
      LIEKAN_ANALYSIS_GLOBAL_LIMIT_MIB: '8192',
    }),
  ).toThrow('LIEKAN_ANALYSIS_GLOBAL_LIMIT_MIB');
});
it('retains construction headroom below the recovery line at the smallest valid budgets', async () => {
  const { readAnalysisStorageLimits } = await import('./analysis-storage-limits');
  const { hasAnalysisBuildCapacity, storageHistoryAllowed } = await import('./storage-capacity');
  const limits = readAnalysisStorageLimits({
    LIEKAN_ANALYSIS_SITE_LIMIT_MIB: '512',
    LIEKAN_ANALYSIS_GLOBAL_LIMIT_MIB: '2048',
  });
  const capacity = {
    ...limits,
    siteBytes: String(Math.floor(limits.siteLimit * 0.89)),
    globalBytes: String(Math.floor(limits.globalLimit * 0.89)),
  };
  expect(storageHistoryAllowed(capacity)).toBe(true);
  expect(hasAnalysisBuildCapacity(capacity)).toBe(true);
});
it('uses the configured capacity for build admission and both SQL thresholds', async () => {
  vi.stubEnv('LIEKAN_ANALYSIS_SITE_LIMIT_MIB', '2048');
  vi.stubEnv('LIEKAN_ANALYSIS_GLOBAL_LIMIT_MIB', '16384');
  vi.resetModules();
  const limits = await import('./analysis-storage-limits');
  const { hasAnalysisBuildCapacity, storageHistorySiteAllowedSql, storageSitePressureSql } =
    await import('./storage-capacity');
  expect(storageHistorySiteAllowedSql).toContain(`${limits.ANALYSIS_SITE_LIMIT}::bigint*90`);
  expect(storageSitePressureSql).toContain(`${limits.ANALYSIS_SITE_LIMIT}::bigint*80`);
  expect(
    hasAnalysisBuildCapacity({
      siteBytes: String(1014 * 1024 ** 2),
      globalBytes: '0',
      siteLimit: limits.ANALYSIS_SITE_LIMIT,
      globalLimit: limits.ANALYSIS_GLOBAL_LIMIT,
    }),
  ).toBe(true);
});
