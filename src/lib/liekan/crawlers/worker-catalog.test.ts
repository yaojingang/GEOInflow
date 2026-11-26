// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  quality: vi.fn(),
  pointer: vi.fn(),
  catalog: vi.fn(),
  invalidate: vi.fn(),
  reconcile: vi.fn(),
  authorityRead: vi.fn(),
}));
vi.mock('../warehouse/control-db', async importOriginal => ({
  ...(await importOriginal<typeof import('../warehouse/control-db')>()),
  ControlDatabase: class {
    read = mocks.authorityRead;
  },
}));
vi.mock('../upstream/ai-db', () => ({ aiTransaction: (work: any) => work(mocks) }));
vi.mock('../upstream/crawler-access', () => ({ crawlerTransaction: (work: any) => work(mocks) }));
vi.mock('../upstream/crawler-registry', async importOriginal => ({
  ...(await importOriginal<typeof import('../upstream/crawler-registry')>()),
  readCrawlerRegistryPointer: mocks.pointer,
  readPublishedRegistry: mocks.catalog,
}));
vi.mock('../upstream/query-cache', () => ({
  analyticsCache: { invalidate: mocks.invalidate },
  websiteCacheTag: (id: string) => id,
}));
vi.mock('./analysis', () => ({
  crawlerBase: 'FROM liekan_effective_log l WHERE l.website_id=$1::uuid',
  crawlerCountColumns: 'count(*) AS requests',
  crawlerWindowQuality: mocks.quality,
}));
vi.mock('./workflow-lifecycle', () => ({ reconcileFindingWorkflow: mocks.reconcile }));

import { processCrawlerAnalysis, recomputeCrawlerRisks } from './worker';
import { getBundledPublishedCatalog } from './catalog-seed';
import { getPublishedCatalog } from './published';

const websiteId = randomUUID(),
  workerId = randomUUID();
const now = Date.parse('2026-10-20T12:15:00Z');
const quality = {
  state: 'unknown',
  basis: 'event_time',
  classificationVersion: '',
  sourceVersion: '',
  timezone: 'UTC',
};
let published: ReturnType<typeof getBundledPublishedCatalog>;
let live: { epoch: number; data_revision: number };
let leased: boolean;
let authority: { authority: string; revision: string; installation_id: string };
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LIEKAN_WAREHOUSE_TRANSITION', 'false');
  vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', '');
  const seed = getBundledPublishedCatalog();
  published = {
    ...seed,
    version: randomUUID(),
    payload: {
      ...seed.payload,
      identities: seed.payload.identities.filter(row => row.id === 'gptbot'),
    },
  };
  live = { epoch: 1, data_revision: 4 };
  leased = true;
  authority = { authority: 'postgres', revision: '1', installation_id: randomUUID() };
  mocks.authorityRead.mockReset().mockImplementation(async () => [{ ...authority }]);
  mocks.pointer.mockReset().mockImplementation(async () => published);
  mocks.catalog.mockReset().mockImplementation(async () => published);
  mocks.quality.mockReset().mockResolvedValue(quality);
  mocks.execute.mockReset().mockResolvedValue(1);
  mocks.query.mockReset().mockImplementation(async (sql: string, ...args: unknown[]) => {
    if (sql.startsWith('SELECT authority,revision::text,installation_id::text'))
      return [{ ...authority }];
    if (sql.includes('FROM liekan_crawler_registry_current'))
      return [{ version: published.version }];
    if (sql.startsWith('SELECT epoch,data_revision')) return [{ ...live }];
    if (sql.startsWith('SELECT count(*)::int AS count FROM liekan_ingest_batch'))
      return [{ count: 0 }];
    if (sql.startsWith('SELECT s.website_id')) return [{ website_id: websiteId, ...live }];
    if (sql.startsWith('INSERT INTO liekan_crawler_lease')) return [{ name: args[0] }];
    if (sql.startsWith('SELECT expires_at>clock_timestamp()')) return [{ leased }];
    return [];
  });
});

const stateWrites = () =>
  mocks.execute.mock.calls.filter(([sql]) =>
    sql.startsWith('INSERT INTO liekan_crawler_analysis_state'),
  );
const findingWrites = () =>
  mocks.query.mock.calls.filter(([sql]) => sql.startsWith('WITH incoming AS'));

it('persists the captured version in finding facts and state quality under the current pointer lock', async () => {
  await recomputeCrawlerRisks(websiteId, now);
  const findings = JSON.parse(findingWrites()[0][2]);
  expect(findings.length).toBeGreaterThan(0);
  expect(
    findings.every(
      finding => finding.catalogVersion === published.version && finding.botId === 'gptbot',
    ),
  ).toBe(true);
  expect(JSON.parse(stateWrites()[0][5])).toEqual({
    ...quality,
    catalogVersion: published.version,
  });
  expect(
    mocks.query.mock.calls.some(
      ([sql]) => sql === 'SELECT version FROM liekan_crawler_registry_current WHERE id=1 FOR SHARE',
    ),
  ).toBe(true);
  expect(mocks.invalidate).toHaveBeenCalledWith(websiteId);
});

it('discards an older computation after a newer publication has committed its analysis', async () => {
  let release!: () => void;
  let entered: () => void;
  const waiting = new Promise<void>(resolve => {
    entered = resolve;
  });
  const resume = new Promise<void>(resolve => {
    release = resolve;
  });
  const oldVersion = published.version;
  mocks.quality.mockImplementationOnce(async () => {
    entered();
    await resume;
    expect(getPublishedCatalog()?.version).toBe(oldVersion);
    return quality;
  });
  const older = recomputeCrawlerRisks(websiteId, now);
  await waiting;
  published = { ...published, version: randomUUID(), revision: '2' };
  await recomputeCrawlerRisks(websiteId, now);
  release();
  await older;
  expect(stateWrites()).toHaveLength(1);
  expect(JSON.parse(stateWrites()[0][5]).catalogVersion).toBe(published.version);
  expect(findingWrites()).toHaveLength(1);
  expect(mocks.invalidate).toHaveBeenCalledTimes(1);
});

it.each(['epoch', 'data_revision'] as const)(
  'discards analysis when its %s changes during computation',
  async field => {
    mocks.quality.mockImplementationOnce(async () => {
      live[field] += 1;
      return quality;
    });
    await recomputeCrawlerRisks(websiteId, now);
    expect(stateWrites()).toHaveLength(0);
    expect(findingWrites()).toHaveLength(0);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  },
);

it.each([false, true])('rechecks same-day coverage when the catalog changed=%s', async changed => {
  const query = mocks.query.getMockImplementation();
  mocks.query.mockImplementation(async (sql: string, ...args: unknown[]) => {
    if (sql.startsWith('SELECT computed_at,data_revision,window_end'))
      return [
        {
          window_end: new Date('2026-10-20T12:00:00Z'),
          catalog_version: changed ? randomUUID() : published.version,
        },
      ];
    return query(sql, ...args);
  });
  await recomputeCrawlerRisks(websiteId, now);
  expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('SELECT snapshot_at,paths'))).toBe(
    changed,
  );
});

it('selects sites with old catalog metadata immediately and retains the worker lease through commit', async () => {
  await processCrawlerAnalysis(workerId);
  const selection = mocks.query.mock.calls.find(([sql]) => sql.startsWith('SELECT s.website_id'));
  expect(selection[0]).toContain("a.quality->>'catalogVersion' IS DISTINCT FROM $1");
  expect(selection[1]).toBe(published.version);
  expect(
    mocks.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT expires_at>clock_timestamp()')),
  ).toHaveLength(2);
  expect(stateWrites()).toHaveLength(1);
  expect(mocks.execute).toHaveBeenCalledWith(
    'DELETE FROM liekan_crawler_lease WHERE name=$1 AND owner=$2::uuid',
    'analysis',
    workerId,
  );
});

it('rejects worker writes after lease loss without changing newer state or failure status', async () => {
  mocks.quality.mockImplementationOnce(async () => {
    leased = false;
    return quality;
  });
  await processCrawlerAnalysis(workerId);
  expect(stateWrites()).toHaveLength(0);
  expect(findingWrites()).toHaveLength(0);
  expect(mocks.invalidate).not.toHaveBeenCalled();
});

it('does not persist an old failure after publication', async () => {
  mocks.quality.mockImplementationOnce(async () => {
    published = { ...published, version: randomUUID(), revision: '2' };
    throw new Error('old snapshot failed');
  });
  await processCrawlerAnalysis(workerId);
  expect(stateWrites()).toHaveLength(0);
  expect(mocks.query.mock.calls.some(([, name]) => name === `analysis-failure:${websiteId}`)).toBe(
    false,
  );
});

it.each(['direct', 'queued'])(
  'routes %s analysis to PG while the installed authority is PG',
  async entry => {
    vi.stubEnv('DATABASE_URL', 'postgresql://fixture.invalid/warehouse');
    vi.stubEnv('LIEKAN_WAREHOUSE_TRANSITION', 'true');
    vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'clickhouse');
    await (entry === 'direct'
      ? recomputeCrawlerRisks(websiteId, now)
      : processCrawlerAnalysis(workerId));
    expect(stateWrites()).toHaveLength(1);
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('FROM liekan_effective_log'))).toBe(
      true,
    );
    const lock = mocks.query.mock.calls.findIndex(
      ([sql]) =>
        sql ===
        'SELECT authority,revision::text,installation_id::text FROM liekan_warehouse_installation WHERE id=1 FOR SHARE',
    );
    const write = mocks.query.mock.calls.findIndex(([sql]) => sql.startsWith('WITH incoming AS'));
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(write);
  },
);

it.each(['authority', 'revision', 'installation_id'] as const)(
  'discards completed analysis before writing when installation %s changes',
  async field => {
    vi.stubEnv('DATABASE_URL', 'postgresql://fixture.invalid/warehouse');
    vi.stubEnv('LIEKAN_WAREHOUSE_TRANSITION', 'true');
    vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'clickhouse');
    mocks.quality.mockImplementationOnce(async () => {
      authority[field] =
        field === 'authority' ? 'clickhouse' : field === 'revision' ? '2' : randomUUID();
      return quality;
    });
    await expect(recomputeCrawlerRisks(websiteId, now)).rejects.toThrow(
      'warehouse-authority-changed',
    );
    expect(stateWrites()).toHaveLength(0);
    expect(findingWrites()).toHaveLength(0);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  },
);

it('does not persist a failure or cooldown across an authority transition', async () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture.invalid/warehouse');
  vi.stubEnv('LIEKAN_WAREHOUSE_TRANSITION', 'true');
  vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'clickhouse');
  mocks.quality.mockImplementationOnce(async () => {
    authority.revision = '2';
    throw new Error('old authority computation failed');
  });
  await expect(processCrawlerAnalysis(workerId)).rejects.toThrow('warehouse-authority-changed');
  expect(stateWrites()).toHaveLength(0);
  expect(findingWrites()).toHaveLength(0);
  expect(mocks.query.mock.calls.some(([, name]) => name === `analysis-failure:${websiteId}`)).toBe(
    false,
  );
});

it('does not start a crawler job while the installation authority is frozen', async () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture.invalid/warehouse');
  vi.stubEnv('LIEKAN_WAREHOUSE_TRANSITION', 'true');
  vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'clickhouse');
  authority.authority = 'frozen';
  await expect(processCrawlerAnalysis(workerId)).rejects.toThrow('warehouse-authority-frozen');
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
});
