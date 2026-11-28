import { afterEach, expect, it, vi } from 'vitest';
import { recordCrawlerCoverage } from './crawler-quality';
import { crawlerClassificationVersion } from './crawler-evidence';
import { getBotRules } from '../rules/bots';
import { officialRuleConfiguration } from '../rules/configuration';

afterEach(() => vi.unstubAllEnvs());

it('does not promote collector declarations when CH evidence is unavailable', async () => {
  vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'clickhouse');
  const tx = { $queryRawUnsafe: vi.fn(), $executeRawUnsafe: vi.fn() };
  await recordCrawlerCoverage(
    tx,
    { id: 'source', website_id: 'site', kind: 'server', state: 'active' },
    1,
    {
      pending: 0,
      gap: false,
      errorCode: 'none',
      coverage: {
        epoch: 1,
        startsAt: 1000,
        endsAt: 3000,
        fromBatchId: 'first',
        toBatchId: 'last',
        cursors: [{ generation: 'fixture', confirmed: 100, read: 100 }],
      },
    },
    getBotRules(),
    4000,
  );
  expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
});

it('records a partial gap without querying CH coverage evidence', async () => {
  vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'clickhouse');
  const tx = {
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ ending: new Date(1000) }]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  };
  expect(
    await recordCrawlerCoverage(
      tx,
      { id: 'source', website_id: 'site', kind: 'server', state: 'active' },
      1,
      { pending: 0, gap: true, errorCode: 'rotation-gap' },
      getBotRules(),
      4000,
    ),
  ).toEqual({ gapRecorded: true });
  expect(tx.$queryRawUnsafe).toHaveBeenCalledOnce();
  expect(tx.$executeRawUnsafe.mock.calls[0][0]).toContain("state='partial'");
});

it('binds observed file coverage to the full configuration including signed identity settings', async () => {
  const configuration = { ...officialRuleConfiguration(), disabledIds: ['chatgpt-agent'] };
  const rules = getBotRules();
  const version = crawlerClassificationVersion(rules, configuration);
  const tx = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    $queryRawUnsafe: vi.fn(async (sql: string, ..._params: unknown[]) => {
      if (sql.includes('SELECT b.id'))
        return [
          {
            id: 'first',
            epoch: 1,
            state: 'processed',
            rejected: 0,
            first_event: new Date(1000),
            received_at: new Date(1500),
          },
          { id: 'last', epoch: 1, state: 'processed', rejected: 0, last_event: new Date(3000) },
        ];
      if (sql.includes('SELECT count(*)')) return [{ count: 0 }];
      if (sql.includes('FROM liekan_log_interval')) return [{ id: 'interval' }];
      return [];
    }),
  };
  await recordCrawlerCoverage(
    tx,
    { id: 'source', website_id: 'site', kind: 'server', state: 'active' },
    1,
    {
      pending: 0,
      gap: false,
      errorCode: 'none',
      coverage: {
        epoch: 1,
        startsAt: 1000,
        endsAt: 3000,
        fromBatchId: 'first',
        toBatchId: 'last',
        cursors: [{ generation: 'fixture', confirmed: 100, read: 100 }],
      },
    },
    rules,
    4000,
    configuration,
  );
  const check = tx.$queryRawUnsafe.mock.calls.find(([sql]) =>
    sql.includes('e.classification_version IS DISTINCT FROM'),
  );
  expect(check[4]).toBe(version);
  const insert = tx.$executeRawUnsafe.mock.calls.find(([sql]) =>
    sql.includes('INSERT INTO liekan_crawler_quality'),
  );
  expect(JSON.parse(insert[5])).toMatchObject({
    classificationVersion: version,
    declaration: 'collector_observed_file_range',
  });
  expect(version).not.toBe(crawlerClassificationVersion(rules, officialRuleConfiguration()));
});
