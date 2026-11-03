// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  query: vi.fn(),
  write: vi.fn(),
  authorize: vi.fn(),
  execute: vi.fn(),
  rows: [] as any[],
}));
vi.mock('@/lib/auth', () => ({ hasPermission: async () => false }));
vi.mock('./ai-db', () => ({ aiExecutor: (tx: unknown) => tx }));
vi.mock('./crawler-access', () => ({ authorizeCrawler: m.authorize }));
vi.mock('./analytics-revision', () => ({
  readAnalyticsVersions: async () => ({ strong: 'current' }),
}));
vi.mock('./analysis-rollups-db', () => ({
  analysisTransaction: (work: (tx: unknown) => unknown) =>
    work({ $queryRawUnsafe: m.query, $executeRawUnsafe: m.write }),
  analysisCapacity: async () => ({
    globalBytes: '0',
    siteBytes: '0',
    globalLimit: '100000000',
    siteLimit: '10000000',
  }),
}));
vi.mock('./analysis-background', () => ({
  withAnalysisPermit: async (_kind: string, work: any) => ({
    acquired: true,
    value: await work(() => true, { token: 'permit', epoch: 1n }),
  }),
}));
vi.mock('./analysis-query-execution', () => ({ executeAnalysisQuery: m.execute }));
vi.mock('./dashboard-snapshots', () => ({
  dashboardJobClock: async () => undefined,
  publishDashboardSnapshot: async () => {},
}));
vi.mock('./crawler-registry-context', () => ({
  withPublishedRegistry: (work: () => unknown) => work(),
}));
vi.mock('../crawlers/published', () => ({ getPublishedCatalog: () => ({ version: 'catalog' }) }));
import { processAnalysisQuery, readAnalysisQuery, requestAnalysisQuery } from './analysis-queries';
import { ANALYSIS_RESULT_FORMAT, encodeAnalysisEnvelope } from './analysis-query-model';
import { noteBrowserPopulation, noteCacheResult, withQueryCacheHeaders } from './cache-context';
const site = '11111111-1111-4111-8111-111111111111',
  actor = { id: 'actor', role: 'user' };
const population = {
  resourceId: site,
  populationVersion: 'browser-population-v4',
  resourceKind: 'website' as const,
  capability: 'supported' as const,
  scope: 'resource-window' as const,
  policyRevision: '1',
  historyActiveGeneration: null,
  historyRevision: null,
  epoch: '3',
  governanceRevision: '4',
  governanceWatermark: null,
  identity: {
    status: 'partial' as const,
    eligibleEvents: 8,
    eligiblePV: 5,
    qualifiedPV: 2,
    qualifiedVisitors: 1,
    coverage: 0.4,
    versions: ['identity-v1'],
  },
  ruleVersions: ['rule-v1'],
  catalogVersions: ['catalog-v1'],
  versionSetsTruncated: false,
  range: { startAt: 1000, endAt: 2000, timezone: 'UTC' },
};
function row(extra: Record<string, unknown> = {}) {
  return {
    id: 'job',
    website_id: site,
    actor_id: actor.id,
    target: 'native:metrics',
    parameters: { ...population.range, type: 'browser' },
    query_key: 'key',
    strong_version: 'current',
    catalog_version: null,
    epoch: 3n,
    status: 'ready',
    forced: false,
    locale: 'zh-CN',
    result: JSON.parse(encodeAnalysisEnvelope([{ x: 'Chrome', y: null }], [population], site)),
    queued_at: new Date(),
    started_at: new Date(),
    completed_at: new Date(),
    generated_at: new Date(Date.now() - 1000),
    expires_at: new Date(Date.now() + 60000),
    retention_until: new Date(Date.now() + 86400000),
    error_code: null,
    lease_token: 'lease',
    attempts: 1,
    ...extra,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  m.rows = [row()];
  m.authorize.mockResolvedValue({
    id: site,
    name: 'current site',
    domain: 'fixture.invalid',
    ownerUserId: actor.id,
  });
  m.query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT s.epoch')) return [{ epoch: 3n, siteNumber: 107 }];
    if (sql.includes('liekan_analysis_background_lease')) return [{ id: true }];
    if (sql.startsWith('SELECT 1 FROM liekan_analysis_query_consumer')) return [{ present: 1 }];
    if (sql.startsWith("UPDATE liekan_analysis_query q SET status='running'")) return [m.rows[0]];
    if (sql.includes('FROM liekan_analysis_query')) return m.rows;
    throw new Error(`Unexpected synthetic query: ${sql}`);
  });
  m.write.mockResolvedValue(1);
});
async function response(work: () => Promise<any>) {
  return withQueryCacheHeaders(async () => {
    const result = await work();
    return Response.json(result);
  });
}
it.each(['result', 'ready', 'previous'])(
  'replays stored exact-window population for %s without exposing its envelope',
  async mode => {
    if (mode === 'previous') m.rows.unshift(row({ status: 'queued', forced: true }));
    const result = await response(() =>
      mode === 'result'
        ? readAnalysisQuery(site, actor, 'job', true)
        : requestAnalysisQuery(site, actor, 'native:metrics', {
            ...population.range,
            type: 'browser',
            ...(mode === 'previous' ? { refresh: '1' } : {}),
          }),
    );
    const body = await result.json();
    expect(mode === 'previous' ? body.previousResult : body.value).toEqual([
      { x: 'Chrome', y: null },
    ]);
    expect(JSON.parse(result.headers.get('X-Liekan-Population')).populations).toEqual([population]);
    expect(JSON.stringify(body)).not.toContain(ANALYSIS_RESULT_FORMAT);
    expect(m.execute).not.toHaveBeenCalled();
  },
);
it('publishes only the recomputed value and metadata after a stale input retry', async () => {
  m.rows = [row({ status: 'running' })];
  m.execute.mockImplementation(async () => {
    const retry = m.execute.mock.calls.length === 2;
    noteBrowserPopulation(site, { ...population, policyRevision: retry ? 'fresh' : 'expired' });
    noteCacheResult({
      value: [],
      generatedAt: Date.now(),
      expiresAt: Date.now() + (retry ? 30000 : -1),
      status: 'miss',
    });
    return [{ x: retry ? 'fresh' : 'expired', y: null }];
  });
  expect(await processAnalysisQuery('job')).toEqual({
    acquired: true,
    value: undefined,
    retryDelivery: false,
    wakeDashboardHead: false,
  });
  expect(m.execute).toHaveBeenCalledTimes(2);
  const published = m.write.mock.calls.find(([sql]) => sql.includes("SET status='ready'"));
  const stored = JSON.parse(published[3]);
  expect(stored.value).toEqual([{ x: 'fresh', y: null }]);
  expect(stored.populations).toEqual([{ ...population, policyRevision: 'fresh' }]);
  expect(published[4]).toBe(Buffer.byteLength(published[3]));
});
it('keeps metadata private when current website authorization is rejected', async () => {
  m.authorize.mockRejectedValue(new Error('forbidden'));
  const result = await withQueryCacheHeaders(async () => {
    await expect(readAnalysisQuery(site, actor, 'job', true)).rejects.toThrow('forbidden');
    return Response.json({ error: 'forbidden' }, { status: 403 });
  });
  expect(result.headers.has('X-Liekan-Population')).toBe(false);
  expect(m.query).not.toHaveBeenCalled();
});
