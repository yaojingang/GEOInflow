import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({
  user: '10000000-0000-4000-8000-000000000001',
  site: '10000000-0000-4000-8000-000000000002',
  conversation: '10000000-0000-4000-8000-000000000003',
  epoch: '10000000-0000-4000-8000-000000000004',
  catalog: '10000000-0000-4000-8000-000000000005',
}));
const fixture = vi.hoisted(() => ({ current: 'partial', previous: 'complete', empty: false }));
vi.mock('../ai/conversations', () => ({
  loadAiConversation: async () => ({
    site: { id: ids.site, ownerUserId: ids.user, teamId: null },
    row: { website_epoch: ids.epoch },
    space: { kind: 'personal', id: ids.user },
  }),
}));
vi.mock('./ai-facts-db', () => ({
  getAiFactsClient: () => ({
    $transaction: async (work: (tx: any) => unknown) =>
      work({ $executeRawUnsafe: async () => {}, $queryRawUnsafe: async () => [] }),
  }),
}));
vi.mock('./ai-log-read-priority', () => ({ waitForLogStatisticsReads: async () => {} }));
vi.mock('../crawlers/published', () => ({ getPublishedCatalog: () => ({ version: ids.catalog }) }));
vi.mock('./crawler-registry-context', () => ({
  withPublishedRegistry: (work: () => unknown) => work(),
}));
vi.mock('./filter-extension', () => ({ channelFilterColumn: () => "'AI 搜索引荐'" }));
vi.mock('../rules/population', () => ({ crawlerAiSql: () => 'FALSE' }));
vi.mock('./browser-population', async importOriginal => {
  const original = await importOriginal<typeof import('./browser-population')>();
  return {
    ...original,
    readBrowserPopulation: async (_id: string, start: Date, end: Date) => {
      const current = +start === +new Date('2026-10-01T00:00:00Z');
      const status = current ? fixture.current : fixture.previous;
      const events = current && fixture.empty ? 0 : 4;
      return original.populationFromRow(
        {
          resourceKind: 'website',
          eligibleEvents: events,
          qualifiedEvents: status === 'unavailable' ? 0 : status === 'partial' ? 2 : events,
          eligiblePV: events,
          qualifiedPV: status === 'unavailable' ? 0 : status === 'partial' ? 2 : events,
          qualifiedVisitors: events && status !== 'unavailable' ? 2 : 0,
        },
        { startAt: +start, endAt: +end, timezone: 'UTC' },
      );
    },
  };
});
vi.mock('./server', () => ({
  query: async (sql: string) => {
    if (sql.includes('SELECT w.website_id AS id'))
      return [
        {
          id: ids.site,
          name: 'Synthetic identity fixture',
          domain: 'synthetic.test',
          owner: ids.user,
          team: null,
          epoch: ids.epoch,
        },
      ];
    if (sql.includes('active_generation::text')) return [];
    if (sql.includes('coalesce(sum(pv),0)::bigint AS "pageviews"'))
      return [
        {
          period: 0,
          pageviews: fixture.empty ? 0 : 4,
          visitors: fixture.empty ? 0 : 2,
          visits: fixture.empty ? 0 : 4,
        },
        { period: 1, pageviews: 2, visitors: 1, visits: 2 },
      ];
    if (sql.includes(' AS connected,'))
      return [{ connected: false, browser: true, catalog: 0, goals: 1, invalid: 0 }];
    if (sql.includes(', definitions AS ('))
      return [
        {
          name: 'Purchase',
          type: 'event',
          count: fixture.empty ? 0 : 3,
          previous: 2,
          converted: fixture.empty ? 0 : 2,
          previousConverted: 1,
          total: 1,
        },
      ];
    if (sql.includes(', entry_visits AS ('))
      return [
        { period: 0, visits: 1, pv: 2 },
        { period: 1, visits: 1, pv: 1 },
      ];
    return [];
  },
}));

import { prepareAiPrompt } from '../ai/prompt';
import { buildAiFactsContext } from './ai-facts';

beforeEach(() => {
  fixture.current = 'partial';
  fixture.previous = 'complete';
  fixture.empty = false;
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic:synthetic@127.0.0.1/synthetic');
  vi.stubEnv('CLICKHOUSE_URL', '');
});
afterEach(() => vi.unstubAllEnvs());
async function goalFact() {
  const context = await buildAiFactsContext({
    actor: { id: ids.user, role: 'user' },
    conversationId: ids.conversation,
    input: {
      clientRequestId: ids.conversation,
      expectedConfigVersion: 1,
      question: 'Explain conversion',
      startAt: '2026-10-01T00:00:00.000Z',
      endAt: '2026-10-01T23:59:59.999Z',
      timezone: 'UTC',
    },
    signal: new AbortController().signal,
  });
  const goal = context.facts.find(fact => fact.id === 'goals');
  if (goal?.id !== 'goals') throw new Error('Goal facts required');
  return { context, row: goal.data.rows[0] };
}
describe('AI goal rates preserve identity availability', () => {
  it.each([
    ['zh-CN', false],
    ['zh-CN', true],
    ['en-US', false],
    ['en-US', true],
  ] as const)(
    'fits a one-day %s analysis with structured=%s and real population metadata',
    async (locale, structuredOutput) => {
      const { context } = await goalFact();
      const prepared = prepareAiPrompt({
        context,
        locale,
        question: locale === 'zh-CN' ? '今天浏览如何' : 'How was traffic today?',
        history: [],
        structuredOutput,
        connectionConfig: {
          provider: 'custom',
          protocol: 'openai-chat',
          baseUrl: 'https://models.example.com/v1',
          model: 'gpt-5.6-terra',
        },
      });
      expect(prepared.inputBytes).toBeLessThanOrEqual(12697);
      expect(prepared.contextSent.population).toEqual(context.population);
      expect(prepared.contextSent.previousPopulation).toEqual(context.previousPopulation);
      expect(prepared.contextSent.metrics).toEqual(context.metrics);
      expect(prepared.contextSent.facts.map(fact => fact.id)).toEqual(
        context.facts.map(fact => fact.id),
      );
    },
  );
  it('bounds observed version lists while retaining identity coverage and statistics', async () => {
    const { context } = await goalFact();
    for (const population of [context.population, context.previousPopulation]) {
      population.identity.versions = Array.from(
        { length: 32 },
        (_, n) => `cookieless-trusted-input-v${n}`,
      );
      population.identity.qualifiedVersions = [...population.identity.versions];
      population.ruleVersions = Array.from(
        { length: 32 },
        (_, n) => `traffic-quality-policy-test-v${n}`,
      );
      population.catalogVersions = Array.from(
        { length: 32 },
        (_, n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      );
    }
    const prepared = prepareAiPrompt({
      context,
      question: '今天浏览如何',
      history: [],
      connectionConfig: {
        provider: 'custom',
        protocol: 'openai-chat',
        baseUrl: 'https://models.example.com/v1',
        model: 'gpt-5.6-terra',
      },
    });
    expect(prepared.inputBytes).toBeLessThanOrEqual(12697);
    expect(prepared.contextSent.population.versionSetsTruncated).toBe(true);
    for (const key of ['population', 'previousPopulation'] as const) {
      expect(prepared.contextSent[key].identity).toMatchObject({
        status: context[key].identity.status,
        qualifiedPV: context[key].identity.qualifiedPV,
        qualifiedVisitors: context[key].identity.qualifiedVisitors,
        coverage: context[key].identity.coverage,
      });
      expect(context[key].identity.versions).toHaveLength(32);
      expect(context[key].versionSetsTruncated).toBe(false);
    }
    expect(prepared.contextSent.metrics).toEqual(context.metrics);
    expect(prepared.contextSent.facts).toEqual(context.facts);
  });
  it.each([
    ['unavailable', 'complete'],
    ['partial', 'complete'],
    ['complete', 'unavailable'],
    ['complete', 'partial'],
    ['complete', 'complete'],
  ])(
    'gates entry-attributed AI pageviews for %s current and %s previous identities',
    async (current, previous) => {
      fixture.current = current;
      fixture.previous = previous;
      const { context, row } = await goalFact();
      const referrals = context.facts.find(fact => fact.id === 'ai-referrals');
      expect(referrals?.data).toMatchObject({
        visits: current === 'complete' ? 1 : null,
        pageviews: current === 'complete' ? 2 : null,
        previousVisits: previous === 'complete' ? 1 : null,
        previousPageviews: previous === 'complete' ? 1 : null,
      });
      expect(context.metrics.find(metric => metric.key === 'pageviews')?.value).toBe(4);
      expect(row).toMatchObject({ count: 3, previousCount: 2 });
    },
  );
  it('retains event counts and valid facts when current identity cannot supply a denominator', async () => {
    const { context, row } = await goalFact();
    expect(context.metrics.find(metric => metric.key === 'pageviews')?.value).toBe(4);
    expect(row).toMatchObject({
      count: 3,
      convertedVisits: null,
      ratePercent: null,
      previousCount: 2,
      previousConvertedVisits: 1,
      previousRatePercent: 50,
    });
  });
  it('gates each period independently and retains the complete-window conversion algorithm', async () => {
    fixture.current = 'complete';
    fixture.previous = 'partial';
    expect((await goalFact()).row).toMatchObject({ ratePercent: 50, previousRatePercent: null });
    fixture.previous = 'complete';
    expect((await goalFact()).row).toMatchObject({ ratePercent: 50, previousRatePercent: 50 });
  });
  it('keeps an empty complete period rate undefined', async () => {
    fixture.current = 'complete';
    fixture.empty = true;
    expect((await goalFact()).row).toMatchObject({
      count: 0,
      convertedVisits: 0,
      ratePercent: null,
    });
  });
});
