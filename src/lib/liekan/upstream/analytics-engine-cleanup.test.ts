// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  command: vi.fn(),
  insert: vi.fn(),
  query: vi.fn(),
  permit: vi.fn(),
  admin: vi.fn(),
}));
vi.mock('@clickhouse/client', () => ({
  createClient: () => ({
    command: m.command,
    insert: m.insert,
    query: m.query,
    close: async () => {},
  }),
}));
vi.mock('./analysis-rollups-db', () => ({
  analysisTransaction: (work: any) => work({ $queryRawUnsafe: m.read, $executeRawUnsafe: m.write }),
}));
vi.mock('./analytics-engine', () => ({ engineAdmin: m.admin, engineVersions: vi.fn() }));
vi.mock('./analysis-background', () => ({ withAnalysisPermit: m.permit }));
vi.mock('./query-snapshot', () => ({ getQuerySnapshot: () => null }));
import { engineConnection } from './analytics-engine-clickhouse';
import { readClickHouseLogRollup, readClickHouseLogSeries } from './analytics-engine-read';
import {
  collectEngineGarbage,
  discoverEngineWork,
  pumpAnalyticsEngine,
  runEngineBatch,
} from './analytics-engine-worker';

let state: Record<string, any>, site: Record<string, any>, target: string;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LIEKAN_WAREHOUSE_TRANSITION', 'true');
  vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'postgres');
  vi.stubEnv('CLICKHOUSE_URL', '');
  vi.stubEnv('LIEKAN_ANALYTICS_CLICKHOUSE_URL', 'http://legacy.invalid/legacy');
  target = engineConnection().key;
  state = {
    capture: true,
    syncing: true,
    connection_hash: target,
    installation_id: '11111111-1111-4111-8111-111111111111',
    maintenance_turn: 3,
    actor_id: 'admin',
  };
  site = {
    website_id: '22222222-2222-4222-8222-222222222222',
    epoch: '2',
    purge_through: '2',
    purge_pending: true,
    pending_targets: [target],
    sweep_targets: [target],
    checked: false,
  };
  m.command.mockReset().mockResolvedValue(undefined);
  m.read.mockImplementation(async (sql: string, ...values: any[]) => {
    if (sql.startsWith('SELECT * FROM liekan_analytics_engine WHERE id=1')) return [{ ...state }];
    if (sql.includes('WHERE ((purge_pending')) {
      const belongs =
        (site.purge_pending && site.pending_targets.includes(values[0])) ||
        (values[1] && site.sweep_targets.includes(values[0]) && !site.checked);
      return belongs ? [{ ...site }] : [];
    }
    if (sql.startsWith('SELECT * FROM liekan_analytics_engine_site WHERE website_id='))
      return [{ ...site }];
    throw new Error('Unexpected legacy query');
  });
  m.write.mockImplementation(async (sql: string, ...values: any[]) => {
    if (sql.includes('SET purge_token=')) site.purge_token = values[1];
    if (sql.includes('SET pending_targets=array_remove')) {
      site.pending_targets = site.pending_targets.filter((value: string) => value !== values[1]);
      site.purge_pending = site.pending_targets.length > 0;
      site.checked = true;
    }
    if (sql.includes('SET purge_checked_at=')) site.checked = true;
    return 1;
  });
});
afterEach(() => vi.unstubAllEnvs());

it.each(['transition', 'warehouse'])(
  'disables replica reads, discovery and broad GC during %s intake',
  async mode => {
    if (mode === 'warehouse') {
      vi.stubEnv('LIEKAN_WAREHOUSE_TRANSITION', 'false');
      vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'clickhouse');
    }
    const input = {
      websiteId: site.website_id,
      startDate: new Date('2026-01-01T00:00Z'),
      endDate: new Date('2026-01-01T02:00Z'),
      timezone: 'UTC',
      crawlerMetricsVersion: 1 as const,
    };
    expect(await readClickHouseLogRollup(input)).toBeNull();
    expect(await readClickHouseLogSeries({ ...input, grain: 'hour' })).toBeNull();
    await discoverEngineWork(true);
    await collectEngineGarbage();
    expect(m.read).not.toHaveBeenCalled();
    expect(m.command).not.toHaveBeenCalled();
    expect(m.query).not.toHaveBeenCalled();
  },
);

it('does not claim generations when an old syncing configuration has no cleanup', async () => {
  site.pending_targets = [];
  site.sweep_targets = [];
  expect(await runEngineBatch()).toBe(false);
  expect(m.read.mock.calls.some(([sql]) => sql.includes('FROM liekan_analytics_engine_unit'))).toBe(
    false,
  );
  expect(m.admin).not.toHaveBeenCalled();
  expect(m.insert).not.toHaveBeenCalled();
});

it('cleans a recorded old target after capture stops without scanning retired PG logs', async () => {
  state.capture = false;
  state.connection_hash = 'last-checked-different-target';
  expect(await runEngineBatch()).toBe(true);
  expect(m.command).toHaveBeenCalledWith({
    query: expect.stringContaining('AND source_epoch<{epoch:UInt64}'),
    query_params: { installation: state.installation_id, site: site.website_id, epoch: '2' },
    clickhouse_settings: { mutations_sync: '1' },
  });
  const finished = m.write.mock.calls.find(([sql]) =>
    sql.includes('SET pending_targets=array_remove'),
  );
  expect(finished?.[2]).toBe(target);
  expect(finished?.[0]).toContain('history_cursor=NULL,history_start=NULL,history_end=NULL');
  expect(
    [...m.read.mock.calls, ...m.write.mock.calls].some(([sql]) => /FROM liekan_log\b/.test(sql)),
  ).toBe(false);
  expect(m.insert).not.toHaveBeenCalled();
  expect(m.admin).not.toHaveBeenCalled();
});

it('continues a sweep for late old writes even while old syncing remains enabled', async () => {
  site.purge_pending = false;
  site.pending_targets = [];
  expect(await runEngineBatch()).toBe(true);
  expect(m.command).toHaveBeenCalledOnce();
  expect(m.write.mock.calls.some(([sql]) => sql.includes('SET purge_checked_at='))).toBe(true);
  expect(m.write.mock.calls.some(([sql]) => sql.includes('SET pending_targets='))).toBe(false);
});

it('does not delete another destination or acknowledge failed remote cleanup', async () => {
  site.pending_targets = ['another-target'];
  site.sweep_targets = ['another-target'];
  expect(await runEngineBatch()).toBe(false);
  expect(m.command).not.toHaveBeenCalled();
  site.pending_targets = [target];
  m.command.mockRejectedValueOnce(new Error('transport failure'));
  await expect(runEngineBatch()).rejects.toThrow('transport failure');
  expect(site.pending_targets).toEqual([target]);
  expect(m.write.mock.calls.some(([sql]) => sql.includes('SET pending_targets='))).toBe(false);
});

it('does not acknowledge a cleanup whose site epoch changed during remote I/O', async () => {
  m.command.mockImplementationOnce(async () => {
    site.epoch = '3';
  });
  expect(await runEngineBatch()).toBe(true);
  expect(site.pending_targets).toEqual([target]);
  expect(m.write.mock.calls.some(([sql]) => sql.includes('SET pending_targets='))).toBe(false);
});

it('pumps cleanup through its site lease without an obsolete PG history permit', async () => {
  await pumpAnalyticsEngine();
  expect(m.command).toHaveBeenCalledOnce();
  expect(m.permit).not.toHaveBeenCalled();
  expect(m.query).not.toHaveBeenCalled();
  expect(m.insert).not.toHaveBeenCalled();
});
