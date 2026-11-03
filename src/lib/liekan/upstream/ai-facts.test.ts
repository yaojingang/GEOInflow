// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import prisma, { getRawQueryClient } from '@/lib/prisma';
import { prepareAiPrompt } from '../ai/prompt';
import { aiTransaction } from './ai-db';
import { buildAiFactsContext } from './ai-facts';
import { disconnectAiFactsClient, getAiFactsClient } from './ai-facts-db';
import { withLogStatisticsRead } from './ai-log-read-priority';
import { getLogFacts } from './logs';
import { withinQuerySnapshot } from './query-snapshot';
import { humanTotals } from './server';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';

// This public integration seam intentionally requires the named isolated acceptance database.
const enabled = process.env.LIEKAN_AI_FACTS_TEST === '1';
describe.skipIf(!enabled)('authorized AI facts snapshot (isolated test demo)', () => {
  const ids = {
    user: 'd4000000-0000-4000-8000-000000000001',
    website: 'd4000000-0000-4000-8000-000000000002',
    conversation: 'd4000000-0000-4000-8000-000000000003',
    epoch: 'd4000000-0000-4000-8000-000000000004',
    import: 'd4000000-0000-4000-8000-000000000005',
  };
  let db: any;
  const qualifyBrowserEvents = async (eventIds: readonly string[], withIdentity = true) => {
    for (const eventId of eventIds) {
      await db.query(
        `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status)
         VALUES($1,$2,'browser','browser','{synthetic}','fixture-browser','missing') ON CONFLICT DO NOTHING`,
        [eventId, ids.website],
      );
      if (withIdentity)
        await db.query(
          `INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available)
           VALUES($1,$2,'browser','fixture-trusted-browser',true) ON CONFLICT DO NOTHING`,
          [eventId, ids.website],
        );
    }
  };
  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('The named isolated acceptance database is required');
    const target = new URL(databaseUrl);
    if (
      target.hostname !== '127.0.0.1' ||
      target.port !== '15439' ||
      target.pathname !== '/liekan_ai_acceptance'
    )
      throw new Error('Only the named isolated acceptance database is permitted');
    db = {
      query: (sql: string, params: unknown[] = []) => aiTransaction(tx => tx.query(sql, ...params)),
      end: async () => {
        await disconnectAiFactsClient();
        await prisma.client.$disconnect();
      },
    };
    await db.query('INSERT INTO "user"(user_id,username,password,role) VALUES($1,$2,$3,$4)', [
      ids.user,
      'test-demo-ai-facts',
      'test-demo-no-login',
      'user',
    ]);
    await db.query('INSERT INTO website(website_id,name,domain,user_id) VALUES($1,$2,$3,$4)', [
      ids.website,
      'test-demo-ai-facts',
      'example.com',
      ids.user,
    ]);
    await db.query(
      'INSERT INTO liekan_ai_website_state(website_id,epoch,owner_user_id) VALUES($1,$2,$3)',
      [ids.website, ids.epoch, ids.user],
    );
    await db.query(
      'INSERT INTO liekan_ai_conversation(id,creator_id,owner_user_id,website_id,website_epoch) VALUES($1,$2,$2,$3,$4)',
      [ids.conversation, ids.user, ids.website, ids.epoch],
    );
    await db.query(
      'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1,$2,$3,3,0)',
      [ids.import, ids.website, 'test-demo-ai-facts'],
    );
    await db.query(
      `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification) VALUES
    ('test-demo-current',$1,$2,'2026-10-02T10:00:00Z','/users/alice%2540example.com?api_key=canaryKey','GET',403,0,'canaryIP','canaryHash','canaryUA','canaryLocation','GPTBot','OpenAI','训练','unverified'),
    ('test-demo-previous',$1,$2,'2026-09-29T10:00:00Z','/article/2026','GET',200,0,'canaryIP','canaryHash','canaryUA','canaryLocation','GPTBot','OpenAI','训练','unverified')`,
      [ids.website, ids.import],
    );
  });
  afterAll(async () => {
    if (db) {
      for (const table of ['website_event', 'session', 'report'])
        await db.query(`DELETE FROM ${table} WHERE website_id=$1`, [ids.website]);
      await db.query('DELETE FROM website WHERE website_id=$1', [ids.website]);
      await db.query('DELETE FROM "user" WHERE user_id=$1', [ids.user]);
      await db.end();
    }
  });
  afterEach(async () => {
    if (!db) return;
    // Every scenario starts from the same two log observations, including after assertion failures.
    for (const table of ['website_event', 'session', 'report'])
      await db.query(`DELETE FROM ${table} WHERE website_id=$1`, [ids.website]);
    await db.query(
      "DELETE FROM liekan_log WHERE website_id=$1 AND id NOT IN ('test-demo-current','test-demo-previous')",
      [ids.website],
    );
  });
  const input = {
    clientRequestId: 'd4000000-0000-4000-8000-000000000010',
    expectedConfigVersion: 1,
    question: '测试演示事实',
    startAt: '2026-10-01T00:00:00.000Z',
    endAt: '2026-10-03T23:59:59.999Z',
    timezone: 'UTC',
  };
  it.each(['zh-CN', 'en-US'] as const)(
    'fits real one-day %s facts in the custom-model budget',
    async locale => {
      const context = await buildAiFactsContext({
        actor: { id: ids.user, role: 'user' },
        conversationId: ids.conversation,
        input: { ...input, startAt: '2026-10-02T00:00:00.000Z', endAt: '2026-10-02T23:59:59.999Z' },
        signal: new AbortController().signal,
      });
      expect(context.facts).toHaveLength(6);
      expect(context.population).toBeDefined();
      expect(context.previousPopulation).toBeDefined();
      for (const structuredOutput of [false, true]) {
        const prepared = prepareAiPrompt({
          locale,
          context,
          history: [],
          structuredOutput,
          question: locale === 'zh-CN' ? '今天浏览如何' : 'How was traffic today?',
          connectionConfig: {
            provider: 'custom',
            protocol: 'openai-chat',
            baseUrl: 'https://models.example.com/v1',
            model: 'gpt-5.6-terra',
          },
        });
        expect(prepared.inputBytes).toBeLessThanOrEqual(12697);
        expect(prepared.contextSent.metrics).toEqual(context.metrics);
        expect(prepared.contextSent.population).toEqual(context.population);
        expect(prepared.contextSent.previousPopulation).toEqual(context.previousPopulation);
        expect(prepared.contextSent.sourceStates).toEqual(context.sourceStates);
        expect(prepared.contextSent.facts.map(fact => fact.id)).toEqual(
          context.facts.map(fact => fact.id),
        );
        // Detail may be clipped under the documented budget; all aggregates stay exact.
        for (const fact of prepared.contextSent.facts) {
          const original = context.facts.find(value => value.id === fact.id);
          const aggregates = (data: object) =>
            Object.fromEntries(
              Object.entries(data).filter(
                ([key]) =>
                  ![
                    'rows',
                    'paths',
                    'samples',
                    'omitted',
                    'truncated',
                    'samplesOmitted',
                    'samplesTruncated',
                  ].includes(key),
              ),
            );
          expect(aggregates(fact.data)).toEqual(aggregates(original.data));
          if ('rows' in fact.data || 'paths' in fact.data) {
            const rows = 'rows' in fact.data ? fact.data.rows : fact.data.paths;
            expect(fact.data.omitted).toBe(fact.data.total - rows.length);
            expect(fact.data.truncated).toBe(fact.data.omitted > 0);
          }
          if (fact.id === 'log-errors') {
            expect(fact.data.samplesOmitted).toBe(fact.data.sampleTotal - fact.data.samples.length);
            expect(fact.data.samplesTruncated).toBe(fact.data.samplesOmitted > 0);
          }
        }
      }
    },
  );
  it('prepares both browser periods within one shared five-second scan budget', async () => {
    const primary = getAiFactsClient();
    const original = primary.$transaction.bind(primary);
    const now = Date.now();
    let elapsed = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now + elapsed);
    const transaction = vi.spyOn(primary, '$transaction').mockImplementation(
      (work: any, options: any) =>
        original(
          async (raw: any) =>
            work(
              new Proxy(raw, {
                get(target, key) {
                  const value = target[key];
                  if (key !== '$queryRawUnsafe')
                    return typeof value === 'function' ? value.bind(target) : value;
                  return async (sql: string, ...params: any[]) => {
                    // Model an observed slow browser scan while retaining real snapshot SQL and counts.
                    if (sql.includes('website_event') && sql.includes('"visitors"'))
                      elapsed += 3000;
                    return value.call(target, sql, ...params);
                  };
                },
              }),
            ),
          options,
        ) as any,
    );
    try {
      const context = await buildAiFactsContext({
        actor: { id: ids.user, role: 'user' },
        conversationId: ids.conversation,
        input,
        signal: new AbortController().signal,
      });
      expect(context.facts).toHaveLength(6);
      expect(context.catalogVersion).toMatch(/^[0-9a-f-]{36}$/);
      expect(context.trafficPolicyVersion).toBe(TRAFFIC_POLICY_VERSION);
      expect(context.facts.find(f => f.id === 'summary')?.data).toMatchObject({
        logs: { requests: 1 },
        previousLogs: { requests: 1 },
      });
      expect(elapsed).toBeLessThan(5000);
    } finally {
      transaction.mockRestore();
      clock.mockRestore();
    }
  });
  it('returns real current/previous log counts and sanitized explicit fact DTOs', async () => {
    const context = await buildAiFactsContext({
      actor: { id: ids.user, role: 'user' },
      conversationId: ids.conversation,
      input,
      signal: new AbortController().signal,
    });
    const summary = context.facts.find(f => f.id === 'summary');
    expect(summary?.data).toMatchObject({
      logs: { requests: 1, aiRequests: 1, errors403: 1 },
      previousLogs: { requests: 1, aiRequests: 1 },
    });
    expect(context.facts.find(f => f.id === 'log-errors')?.data).toMatchObject({
      current: { requests: 1, errors403: 1, errors404: 0, errors5xx: 0 },
      previous: { requests: 0, errors403: 0, errors404: 0, errors5xx: 0 },
      previousRequests: 0,
      changePercent: null,
    });
    expect(context.sourceStates.human).toBe('not_connected');
    expect(summary?.data).toMatchObject({ current: null, previous: null });
    expect(context.sourceStates.logs).toBe('available');
    for (const canary of [
      'canaryKey',
      'canaryIP',
      'canaryHash',
      'canaryUA',
      'canaryLocation',
      'alice',
      'example.com?',
    ])
      expect(JSON.stringify(context)).not.toContain(canary);
  });
  it('matches dashboard browser totals across boundaries, shared visit IDs and custom-only visits', async () => {
    const uid = (n: number) => `d4000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const events = [
      [3101, 3201, 3301, '2026-09-28T00:00:00.000Z', 1],
      [3102, 3202, 3301, '2026-09-30T23:59:59.999Z', 1],
      [3103, 3201, 3301, '2026-09-30T23:59:59.9995Z', 1],
      [3104, 3201, 3301, '2026-10-01T00:00:00.000Z', 1],
      [3105, 3202, 3301, '2026-10-03T23:59:59.999Z', 1],
      [3106, 3203, 3302, '2026-10-02T00:00:00.000Z', 2],
      [3107, 3203, 3302, '2026-10-02T00:00:01.000Z', 5],
    ] as const;
    try {
      for (const n of [3201, 3202, 3203])
        await db.query('INSERT INTO session(session_id,website_id) VALUES($1,$2)', [
          uid(n),
          ids.website,
        ]);
      for (const [id, session, visit, at, type] of events)
        await db.query(
          'INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [uid(id), ids.website, uid(session), uid(visit), at, '/test-demo-boundary', type],
        );
      await qualifyBrowserEvents(events.map(([id]) => uid(id)));
      const reference = await aiTransaction(tx =>
        withinQuerySnapshot(
          {
            aiPrivate: true,
            $queryRawUnsafe: (sql, ...params) => tx.query(sql, ...params),
            $executeRawUnsafe: (sql, ...params) => tx.execute(sql, ...params),
          },
          async () => ({
            current: await humanTotals(ids.website, new Date(input.startAt), new Date(input.endAt)),
            previous: await humanTotals(
              ids.website,
              new Date('2026-09-28T00:00:00.000Z'),
              new Date('2026-09-30T23:59:59.999Z'),
            ),
          }),
        ),
      );
      const context = await buildAiFactsContext({
        actor: { id: ids.user, role: 'user' },
        conversationId: ids.conversation,
        input,
        signal: new AbortController().signal,
      });
      const totals = context.facts.find(f => f.id === 'summary');
      if (totals?.id !== 'summary') throw Error('Summary required');
      for (const period of ['current', 'previous'] as const) {
        const { pageviews, visitors, visits } = reference[period];
        expect(totals.data[period]).toEqual({ pageviews, visitors, visits });
        expect(totals.data[period]).toEqual({ pageviews: 2, visitors: 2, visits: 1 });
      }
    } finally {
      for (const [id] of events)
        await db.query('DELETE FROM website_event WHERE event_id=$1 AND website_id=$2', [
          uid(id),
          ids.website,
        ]);
      for (const n of [3201, 3202, 3203])
        await db.query('DELETE FROM session WHERE session_id=$1 AND website_id=$2', [
          uid(n),
          ids.website,
        ]);
    }
  });
  it('requires browser classification and identity evidence before counting a collected pageview', async () => {
    const session = 'd4000000-0000-4000-8000-000000005101';
    const event = 'd4000000-0000-4000-8000-000000005102';
    await db.query('INSERT INTO session(session_id,website_id) VALUES($1,$2)', [
      session,
      ids.website,
    ]);
    await db.query(
      "INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type) VALUES($1,$2,$3,$3,'2026-10-02T10:00:00Z','/test-demo-evidence',1)",
      [event, ids.website, session],
    );
    const read = () =>
      buildAiFactsContext({
        actor: { id: ids.user, role: 'user' },
        conversationId: ids.conversation,
        input,
        signal: new AbortController().signal,
      });
    const summary = (context: Awaited<ReturnType<typeof read>>) =>
      context.facts.find(fact => fact.id === 'summary')?.data;
    const [received] = await db.query(
      'SELECT count(*)::int AS n FROM liekan_raw_website_event WHERE website_id=$1',
      [ids.website],
    );
    expect(received.n).toBe(1);
    expect(summary(await read())).toMatchObject({
      current: { pageviews: 0, visitors: 0, visits: 0 },
    });
    await qualifyBrowserEvents([event], false);
    const unidentified = await read();
    expect(unidentified.population.identity).toMatchObject({
      status: 'unavailable',
      eligiblePV: 1,
      qualifiedPV: 0,
    });
    expect(summary(unidentified)).toMatchObject({
      current: { pageviews: 0, visitors: null, visits: null },
    });
    await qualifyBrowserEvents([event]);
    expect(summary(await read())).toMatchObject({
      current: { pageviews: 1, visitors: 1, visits: 1 },
    });
  });
  it('rejects invalid ranges and another actor through the public preparation seam', async () => {
    await expect(
      buildAiFactsContext({
        actor: { id: ids.user, role: 'user' },
        conversationId: ids.conversation,
        input: { ...input, filters: { ip: 'canaryIP' } } as any,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      buildAiFactsContext({
        actor: { id: 'd4000000-0000-4000-8000-000000000099', role: 'admin' },
        conversationId: ids.conversation,
        input,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('uses actual first-page AI channel attribution and configured goal event/visit semantics', async () => {
    const uid = (n: number) => `d4000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    for (let n = 101; n <= 104; n++)
      await db.query('INSERT INTO session(session_id,website_id) VALUES($1,$2)', [
        uid(n),
        ids.website,
      ]);
    const events = [
      {
        id: uid(201),
        session: uid(101),
        visit: uid(301),
        at: '2026-10-02T10:00:00Z',
        path: '/article',
        type: 1,
        source: 'chatgpt',
        medium: '',
        referrer: 'canary-referrer.example',
        event: null,
      },
      {
        id: uid(202),
        session: uid(101),
        visit: uid(301),
        at: '2026-10-02T10:01:00Z',
        path: '/thanks',
        type: 1,
        source: '',
        medium: '',
        referrer: '',
        event: null,
      },
      {
        id: uid(203),
        session: uid(101),
        visit: uid(301),
        at: '2026-10-02T10:02:00Z',
        path: '/thanks',
        type: 1,
        source: '',
        medium: '',
        referrer: '',
        event: null,
      },
      {
        id: uid(204),
        session: uid(101),
        visit: uid(301),
        at: '2026-10-02T10:03:00Z',
        path: '/thanks',
        type: 2,
        source: '',
        medium: '',
        referrer: '',
        event: 'signup',
      },
      {
        id: uid(205),
        session: uid(101),
        visit: uid(301),
        at: '2026-10-02T10:04:00Z',
        path: '/thanks',
        type: 2,
        source: '',
        medium: '',
        referrer: '',
        event: 'signup',
      },
      {
        id: uid(206),
        session: uid(102),
        visit: uid(302),
        at: '2026-10-02T11:00:00Z',
        path: '/home',
        type: 1,
        source: 'chatgpt',
        medium: 'email',
        referrer: '',
        event: null,
      },
      {
        id: uid(207),
        session: uid(103),
        visit: uid(303),
        at: '2026-09-29T11:00:00Z',
        path: '/home',
        type: 1,
        source: '',
        medium: '',
        referrer: 'perplexity.ai',
        event: null,
      },
      {
        id: uid(208),
        session: uid(103),
        visit: uid(303),
        at: '2026-09-29T11:01:00Z',
        path: '/home',
        type: 2,
        source: '',
        medium: '',
        referrer: '',
        event: 'signup',
      },
      {
        id: uid(209),
        session: uid(104),
        visit: uid(304),
        at: '2026-10-02T12:00:00Z',
        path: '/custom-only',
        type: 2,
        source: '',
        medium: '',
        referrer: '',
        event: 'signup',
      },
    ];
    for (const e of events)
      await db.query(
        'INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type,utm_source,utm_medium,utm_campaign,referrer_domain,event_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          e.id,
          ids.website,
          e.session,
          e.visit,
          e.at,
          e.path,
          e.type,
          e.source,
          e.medium,
          'canary-utm-campaign',
          e.referrer,
          e.event,
        ],
      );
    await qualifyBrowserEvents(events.map(event => event.id));
    for (const [n, name, parameters] of [
      [401, 'test-demo-path', { type: 'path', value: '/thanks' }],
      [402, 'test-demo-event alice@example.com', { type: 'event', value: 'signup' }],
      [403, 'test-demo-invalid', { type: 'path' }],
    ] as const)
      await db.query(
        'INSERT INTO report(report_id,user_id,website_id,type,name,description,parameters) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
        [uid(n), ids.user, ids.website, 'goal', name, 'test-demo', JSON.stringify(parameters)],
      );
    const context = await buildAiFactsContext({
      actor: { id: ids.user, role: 'user' },
      conversationId: ids.conversation,
      input,
      signal: new AbortController().signal,
    });
    expect(context.facts.find(f => f.id === 'summary')?.data).toMatchObject({
      current: { pageviews: 4, visitors: 2, visits: 2 },
      previous: { pageviews: 1, visitors: 1, visits: 1 },
      changePercent: { pageviews: 300, visitors: 100, visits: 100 },
    });
    expect(context.facts.find(f => f.id === 'ai-referrals')?.data).toMatchObject({
      visits: 1,
      pageviews: 3,
      previousVisits: 1,
      previousPageviews: 1,
    });
    const pages = context.facts.find(f => f.id === 'pages');
    expect(pages?.data).toMatchObject({ total: 5, omitted: 0, truncated: false });
    if (pages?.id === 'pages') {
      expect(pages.data.rows.find(row => row.path === '/home')).toMatchObject({
        humanPageviews: 1,
        previousHumanPageviews: 1,
        aiRequests: 0,
        previousAiRequests: 0,
      });
      expect(pages.data.rows.find(row => row.path === '/article/2026')).toMatchObject({
        humanPageviews: 0,
        previousHumanPageviews: 0,
        aiRequests: 0,
        previousAiRequests: 1,
      });
      expect(pages.data.rows.find(row => row.path === '/thanks')).toMatchObject({
        humanPageviews: 2,
        previousHumanPageviews: 0,
        aiRequests: 0,
        previousAiRequests: 0,
      });
    }
    const prepared = prepareAiPrompt({
      context,
      question: '核对当前统计',
      history: [],
      connectionConfig: {
        provider: 'custom',
        protocol: 'openai-chat',
        baseUrl: 'https://models.example.com/v1',
        model: 'test-demo',
      },
    });
    expect(prepared.contextSent.metrics).toEqual(context.metrics);
    expect(prepared.contextSent.facts).toHaveLength(6);
    expect(prepared.inputBytes + 2048).toBeLessThanOrEqual(Math.floor(16384 * 0.9));
    const goals = context.facts.find(f => f.id === 'goals');
    expect(goals?.data).toMatchObject({ configured: 3, invalidDefinitions: 1, total: 2 });
    if (goals?.id === 'goals') {
      expect(goals.data.rows.find(r => r.type === 'path')).toMatchObject({
        count: 2,
        convertedVisits: 1,
        ratePercent: 50,
        previousCount: 0,
        changePercent: null,
      });
      expect(goals.data.rows.find(r => r.type === 'event')).toMatchObject({
        count: 3,
        convertedVisits: 1,
        ratePercent: 50,
        previousCount: 1,
        previousConvertedVisits: 1,
        previousRatePercent: 100,
      });
    }
    expect(JSON.stringify(context)).not.toMatch(
      /canary-utm|canary-referrer|alice@example.com|signup/,
    );
    for (const table of ['website_event', 'session', 'report'])
      await db.query(`DELETE FROM ${table} WHERE website_id=$1`, [ids.website]);
    const periodEmpty = await buildAiFactsContext({
      actor: { id: ids.user, role: 'user' },
      conversationId: ids.conversation,
      input: { ...input, startAt: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T23:59:59.999Z' },
      signal: new AbortController().signal,
    });
    expect(periodEmpty.sourceStates.logs).toBe('empty');
    expect(periodEmpty.facts.find(f => f.id === 'log-errors')?.data).toMatchObject({
      current: { requests: 0, errors403: 0, errors404: 0, errors5xx: 0 },
      previous: { requests: 0, errors403: 0, errors404: 0, errors5xx: 0 },
    });
    expect(periodEmpty.facts.find(f => f.id === 'summary')?.data).toMatchObject({
      logs: { requests: 0 },
    });
  });
  it('keeps unsupported storage as null local guidance facts without a provider request', async () => {
    process.env.CLICKHOUSE_URL = 'http://test-demo-clickhouse.invalid';
    try {
      const context = await buildAiFactsContext({
        actor: { id: ids.user, role: 'user' },
        conversationId: ids.conversation,
        input,
        signal: new AbortController().signal,
      });
      expect(context.facts).toEqual([]);
      expect(context.sourceStates.human).toBe('unsupported');
      expect(context.metrics.every(m => m.value === null && m.state === 'unsupported')).toBe(true);
    } finally {
      delete process.env.CLICKHOUSE_URL;
    }
  });

  it('preserves complete summary totals and bounded mixed-class bot aggregates across both periods', async () => {
    const insert = async (
      id: string,
      name: string,
      type: string,
      at: string,
      status: number,
      path: string,
    ) =>
      db.query(
        `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification) VALUES($1,$2,$3,$4,$5,'GET',$6,0,'','','','',$7,'test-demo',$8,'test-demo-unknown')`,
        [id, ids.website, ids.import, at, path, status, name, type],
      );
    for (let n = 1; n <= 25; n++)
      await insert(
        `test-demo-bin-current-${n}`,
        `test-demo-bot-${n}`,
        '搜索',
        '2026-10-02T14:00:00Z',
        n === 1 ? 403 : n === 2 ? 404 : n === 3 ? 503 : 200,
        `/test-demo-bin/${n}`,
      );
    await insert(
      'test-demo-bin-current-other',
      'test-demo-Google',
      '传统搜索',
      '2026-10-02T14:00:00Z',
      200,
      '/test-demo-bin/other',
    );
    await insert(
      'test-demo-bin-previous-25a',
      'test-demo-bot-25',
      '搜索',
      '2026-09-29T14:00:00Z',
      404,
      '/test-demo-bin/25',
    );
    await insert(
      'test-demo-bin-previous-25b',
      'test-demo-bot-25',
      '搜索',
      '2026-09-29T14:01:00Z',
      503,
      '/test-demo-bin/25',
    );
    await insert(
      'test-demo-bin-previous-only',
      'test-demo-prior-only',
      '用户触发',
      '2026-09-29T14:00:00Z',
      403,
      '/test-demo-bin/prior-only',
    );
    await insert(
      'test-demo-bin-previous-other',
      'test-demo-Google',
      '传统搜索',
      '2026-09-29T14:00:00Z',
      404,
      '/test-demo-bin/other',
    );
    const context = await buildAiFactsContext({
      actor: { id: ids.user, role: 'user' },
      conversationId: ids.conversation,
      input,
      signal: new AbortController().signal,
    });
    expect(context.facts.find(f => f.id === 'summary')?.data).toMatchObject({
      logs: { requests: 27, aiRequests: 26, errors403: 2, errors404: 1, errors5xx: 1 },
      previousLogs: { requests: 5, aiRequests: 4, errors403: 1, errors404: 2, errors5xx: 1 },
    });
    const bots = context.facts.find(f => f.id === 'bots');
    expect(bots?.data).toMatchObject({
      total: 27,
      omitted: 7,
      truncated: true,
      requests: 26,
      previousRequests: 4,
    });
    if (bots?.id === 'bots') {
      expect(bots.data.rows).toHaveLength(20);
      expect(bots.data.rows.find(row => row.name === 'test-demo-bot-25')).toMatchObject({
        requests: 1,
        previousRequests: 2,
        changePercent: -50,
        verification: 'unverified',
      });
      expect(bots.data.rows.some(row => row.name === 'test-demo-Google')).toBe(false);
    }
    expect(context.facts.find(f => f.id === 'log-errors')?.data).toMatchObject({
      current: { requests: 4, errors403: 2, errors404: 1, errors5xx: 1 },
      previous: { requests: 4, errors403: 1, errors404: 2, errors5xx: 1 },
      changePercent: 0,
    });
    const pages = context.facts.find(f => f.id === 'pages');
    expect(pages?.data).toMatchObject({ total: 28, omitted: 8, truncated: true });
    if (pages?.id === 'pages') {
      expect(pages.data.rows).toHaveLength(20);
      expect(pages.data.rows.find(row => row.path === '/test-demo-bin/25')).toMatchObject({
        humanPageviews: null,
        previousHumanPageviews: null,
        aiRequests: 1,
        previousAiRequests: 2,
      });
    }
    await db.query("DELETE FROM liekan_log WHERE website_id=$1 AND id LIKE 'test-demo-bin-%'", [
      ids.website,
    ]);
  });

  it('reuses log bins without counting non-AI pages or duplicating normalized bot classes', async () => {
    try {
      await db.query(
        `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification) VALUES
        ('test-demo-group-current',$1,$2,'2026-10-02T10:00:00Z','/shared?ignored=1','GET',200,0,'','','','','GPTBot','OpenAI','训练','legacy_unknown'),
        ('test-demo-group-previous',$1,$2,'2026-09-29T10:00:00Z','/shared#ignored','GET',200,0,'','','','','GPTBot','OpenAI','训练','unverified'),
        ('test-demo-group-prior-only',$1,$2,'2026-09-29T10:00:00Z','/prior-only','GET',200,0,'','','','','GPTBot','OpenAI','训练','legacy_unknown'),
        ('test-demo-group-non-ai',$1,$2,'2026-10-02T10:00:00Z','/non-ai-only','GET',404,0,'','','','','Other','Other','传统搜索','unverified')`,
        [ids.website, ids.import],
      );
      const context = await buildAiFactsContext({
        actor: { id: ids.user, role: 'user' },
        conversationId: ids.conversation,
        input,
        signal: new AbortController().signal,
      });
      expect(context.facts.find(f => f.id === 'summary')?.data).toMatchObject({
        logs: { requests: 3, aiRequests: 2, errors403: 1, errors404: 1 },
        previousLogs: { requests: 3, aiRequests: 3 },
      });
      const bots = context.facts.find(f => f.id === 'bots');
      if (bots?.id !== 'bots') throw Error('Bot facts required');
      expect(bots.data.rows).toHaveLength(1);
      expect(bots.data.rows[0]).toMatchObject({
        name: 'GPTBot',
        verification: 'unverified',
        requests: 2,
        previousRequests: 3,
      });
      const pages = context.facts.find(f => f.id === 'pages');
      if (pages?.id !== 'pages') throw Error('Page facts required');
      expect(pages.data.rows.find(row => row.path === '/shared')).toMatchObject({
        aiRequests: 1,
        previousAiRequests: 1,
      });
      expect(pages.data.rows.find(row => row.path === '/prior-only')).toMatchObject({
        aiRequests: 0,
        previousAiRequests: 1,
      });
      expect(pages.data.rows.some(row => row.path === '/non-ai-only')).toBe(false);
      const errors = context.facts.find(f => f.id === 'log-errors');
      if (errors?.id !== 'log-errors') throw Error('Error facts required');
      expect(errors.data.paths.find(row => row.path === '/non-ai-only')).toMatchObject({
        statusGroup: '404',
        requests: 1,
      });
    } finally {
      await db.query("DELETE FROM liekan_log WHERE website_id=$1 AND id LIKE 'test-demo-group-%'", [
        ids.website,
      ]);
    }
  });

  it('matches dashboard effective logs when manual and automatic source intervals overlap', async () => {
    const source = 'd4000000-0000-4000-8000-000000000081';
    const interval = 'd4000000-0000-4000-8000-000000000082';
    try {
      await db.query(
        "INSERT INTO liekan_log_source(id,website_id,kind,domain,created_by,owner_id,state) VALUES($1,$2,'server','example.com',$3,$3,'active')",
        [source, ids.website, ids.user],
      );
      await db.query(
        "INSERT INTO liekan_log_interval(id,website_id,source_id,starts_at) VALUES($1,$2,$3,'2026-10-01T00:00:00Z')",
        [interval, ids.website, source],
      );
      await db.query(
        "INSERT INTO liekan_log(id,website_id,import_id,source_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification) VALUES('test-demo-automatic',$1,$2,$3,'2026-10-02T11:00:00Z','/automatic','GET',200,0,'','','','','GPTBot','OpenAI','训练','unverified')",
        [ids.website, ids.import, source],
      );
      const context = await buildAiFactsContext({
        actor: { id: ids.user, role: 'user' },
        conversationId: ids.conversation,
        input,
        signal: new AbortController().signal,
      });
      const dashboard = await getLogFacts(
        ids.website,
        new Date(input.startAt),
        new Date(input.endAt),
        'UTC',
        1,
        '',
        '',
        '',
        'after',
        ['summary'],
      );
      expect(context.facts.find(f => f.id === 'summary')?.data).toMatchObject({
        logs: {
          requests: dashboard.summary.requests,
          aiRequests: dashboard.summary.ai,
          errors403: 0,
        },
      });
      expect(context.facts.find(f => f.id === 'log-errors')?.data).toMatchObject({
        current: { requests: 0, errors403: 0 },
      });
    } finally {
      await db.query("DELETE FROM liekan_log WHERE id='test-demo-automatic'");
      await db.query('DELETE FROM liekan_log_interval WHERE id=$1', [interval]);
      await db.query('DELETE FROM liekan_log_source WHERE id=$1', [source]);
    }
  });

  it('retains catalog registration and distinguishes missing log input from measured zero', async () => {
    await db.query('DELETE FROM liekan_import WHERE id=$1', [ids.import]);
    await db.query(
      'INSERT INTO liekan_catalog(website_id,path,title,content_type) VALUES($1,$2,$3,$4)',
      [ids.website, '/test-demo-catalog', 'api_key=canaryKey', 'test-demo'],
    );
    const context = await buildAiFactsContext({
      actor: { id: ids.user, role: 'user' },
      conversationId: ids.conversation,
      input,
      signal: new AbortController().signal,
    });
    expect(context.sourceStates.catalog).toBe('available');
    expect(context.sourceStates.logs).toBe('not_connected');
    expect(context.facts.find(f => f.id === 'summary')?.data).toMatchObject({
      logs: null,
      previousLogs: null,
    });
    expect(context.metrics.find(m => m.key === 'aiRequests')?.value).toBeNull();
    expect(context.facts.find(f => f.id === 'log-errors')?.data).toMatchObject({
      current: null,
      previous: null,
      previousRequests: null,
      changePercent: null,
    });
    expect(JSON.stringify(context)).not.toContain('canaryKey');
  });
  it('distinguishes an active automatic source with zero logs from missing input', async () => {
    const source = 'd4000000-0000-4000-8000-000000000083';
    const interval = 'd4000000-0000-4000-8000-000000000084';
    try {
      await db.query(
        "INSERT INTO liekan_log_source(id,website_id,kind,domain,created_by,owner_id,state) VALUES($1,$2,'server','example.com',$3,$3,'active')",
        [source, ids.website, ids.user],
      );
      await db.query(
        "INSERT INTO liekan_log_interval(id,website_id,source_id,starts_at) VALUES($1,$2,$3,'2026-10-01T00:00:00Z')",
        [interval, ids.website, source],
      );
      const context = await buildAiFactsContext({
        actor: { id: ids.user, role: 'user' },
        conversationId: ids.conversation,
        input,
        signal: new AbortController().signal,
      });
      const dashboard = await getLogFacts(
        ids.website,
        new Date(input.startAt),
        new Date(input.endAt),
        'UTC',
        1,
        '',
        '',
        '',
        'after',
        ['summary', 'latest'],
      );
      expect(dashboard.connected).toBe(true);
      expect(dashboard.latest).toBeNull();
      expect(context.sourceStates.logs).toBe('empty');
      expect(context.metrics.find(m => m.key === 'aiRequests')?.value).toBe(0);
    } finally {
      await db.query('DELETE FROM liekan_log_interval WHERE id=$1', [interval]);
      await db.query('DELETE FROM liekan_log_source WHERE id=$1', [source]);
    }
  });

  it('includes the shared read-queue wait in its five-second facts deadline', async () => {
    let ready: () => void, release: () => void;
    const readyPromise = new Promise<void>(resolve => {
        ready = resolve;
      }),
      releasePromise = new Promise<void>(resolve => {
        release = resolve;
      });
    const blocker = aiTransaction(
      async tx => {
        await tx.query('SELECT true AS acquired FROM pg_advisory_xact_lock(12800073)');
        ready();
        await releasePromise;
      },
      { timeout: 12000 },
    );
    await readyPromise;
    try {
      await expect(
        buildAiFactsContext({
          actor: { id: ids.user, role: 'user' },
          conversationId: ids.conversation,
          input,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'facts_timeout' });
    } finally {
      release();
      await blocker;
    }
  }, 10000);

  it('keeps facts lock waiters out of the ten-connection statistics pool', async () => {
    const primary: any = getRawQueryClient(prisma.client, { write: true });
    const blockerClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 1 }),
    });
    let ready!: () => void, release!: () => void;
    const readyPromise = new Promise<void>(resolve => {
      ready = resolve;
    });
    const releasePromise = new Promise<void>(resolve => {
      release = resolve;
    });
    const blocker = blockerClient.$transaction(
      async tx => {
        await tx.$queryRawUnsafe('SELECT true AS acquired FROM pg_advisory_xact_lock(12800073)');
        ready();
        await releasePromise;
      },
      { timeout: 10000 },
    );
    const tasks: Promise<unknown>[] = [];
    const wave = async () => {
      const start = performance.now();
      await Promise.all(
        Array.from({ length: 10 }, () =>
          primary.$queryRawUnsafe('SELECT true AS completed FROM pg_sleep(0.2)'),
        ),
      );
      return performance.now() - start;
    };
    try {
      await readyPromise;
      await Promise.all(Array.from({ length: 10 }, () => primary.$queryRawUnsafe('SELECT 1')));
      const baselineMs = await wave();
      for (let i = 0; i < 3; i++)
        tasks.push(
          buildAiFactsContext({
            actor: { id: ids.user, role: 'user' },
            conversationId: ids.conversation,
            input,
            signal: new AbortController().signal,
          }),
        );
      let waiting = 0;
      const until = Date.now() + 1500;
      while (!waiting && Date.now() < until) {
        const [row] = await primary.$queryRawUnsafe(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock(12800073)%'",
        );
        waiting = row.n;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBeGreaterThan(0);
      await new Promise(resolve => setTimeout(resolve, 100));
      const [row] = await primary.$queryRawUnsafe(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock(12800073)%'",
      );
      const loadedMs = await wave();
      console.log(
        JSON.stringify({
          factsLockWaiters: row.n,
          statisticsBaselineMs: baselineMs,
          statisticsLoadedMs: loadedMs,
        }),
      );
      expect(row.n).toBe(1);
      expect(loadedMs).toBeLessThanOrEqual(baselineMs * 1.2);
    } finally {
      release();
      await blocker;
      await Promise.allSettled(tasks);
      await blockerClient.$disconnect();
    }
  }, 10000);

  it('bounds private pool acquisition by the same five-second facts deadline', async () => {
    let ready!: () => void, release!: () => void;
    const readyPromise = new Promise<void>(resolve => {
      ready = resolve;
    });
    const releasePromise = new Promise<void>(resolve => {
      release = resolve;
    });
    const blocker = getAiFactsClient().$transaction(
      async () => {
        ready();
        await releasePromise;
      },
      { timeout: 12000 },
    );
    await readyPromise;
    try {
      await expect(
        buildAiFactsContext({
          actor: { id: ids.user, role: 'user' },
          conversationId: ids.conversation,
          input,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'facts_timeout' });
    } finally {
      release();
      await blocker;
    }
    await expect(
      buildAiFactsContext({
        actor: { id: ids.user, role: 'user' },
        conversationId: ids.conversation,
        input,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ website: { id: ids.website } });
  }, 12000);

  it('rejects a cancelled pool waiter and leaves the next facts read available', async () => {
    let ready!: () => void, release!: () => void;
    const readyPromise = new Promise<void>(resolve => {
      ready = resolve;
    });
    const releasePromise = new Promise<void>(resolve => {
      release = resolve;
    });
    const blocker = getAiFactsClient().$transaction(
      async () => {
        ready();
        await releasePromise;
      },
      { timeout: 10000 },
    );
    await readyPromise;
    const controller = new AbortController();
    const result = buildAiFactsContext({
      actor: { id: ids.user, role: 'user' },
      conversationId: ids.conversation,
      input,
      signal: controller.signal,
    }).then(
      () => ({ code: 'unexpected_success' }),
      error => error,
    );
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      controller.abort();
    } finally {
      release();
      await blocker;
    }
    expect(await result).toMatchObject({ code: 'cancelled' });
    await expect(
      buildAiFactsContext({
        actor: { id: ids.user, role: 'user' },
        conversationId: ids.conversation,
        input,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ website: { id: ids.website } });
  }, 10000);

  it('prioritizes an already-started log read before a new facts scan', async () => {
    const primary: any = getRawQueryClient(prisma.client, { write: true });
    const blockerClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 1 }),
    });
    let ready!: () => void, release!: () => void;
    const readyPromise = new Promise<void>(resolve => {
      ready = resolve;
    });
    const releasePromise = new Promise<void>(resolve => {
      release = resolve;
    });
    const blocker = blockerClient.$transaction(
      async tx => {
        await tx.$executeRawUnsafe('LOCK TABLE liekan_log IN ACCESS EXCLUSIVE MODE');
        ready();
        await releasePromise;
      },
      { timeout: 10000 },
    );
    let foreground: Promise<any> | undefined, analysis: Promise<any> | undefined;
    try {
      await readyPromise;
      foreground = getLogFacts(
        ids.website,
        new Date(input.startAt),
        new Date(input.endAt),
        'UTC',
        1,
        '',
        '',
        '',
        'after',
        ['summary'],
      );
      const until = Date.now() + 1500;
      let started = 0;
      while (!started && Date.now() < until) {
        const [row] = await primary.$queryRawUnsafe(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='relation' AND query LIKE '%count(distinct path)%'",
        );
        started = row.n;
        if (!started) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(started).toBeGreaterThan(0);
      analysis = buildAiFactsContext({
        actor: { id: ids.user, role: 'user' },
        conversationId: ids.conversation,
        input,
        signal: new AbortController().signal,
      });
      await new Promise(resolve => setTimeout(resolve, 200));
      const [row] = await primary.$queryRawUnsafe(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='relation' AND query LIKE '%liekan_ai%'",
      );
      console.log(JSON.stringify({ activeForegroundLogRead: started, competingFactsScans: row.n }));
      expect(row.n).toBe(0);
    } finally {
      release();
      await blocker;
      const results = await Promise.allSettled([foreground, analysis].filter(Boolean));
      await blockerClient.$disconnect();
      expect(results).toHaveLength(2);
      expect(results.every(result => result.status === 'fulfilled')).toBe(true);
      const read = results[0] as PromiseFulfilledResult<any>,
        facts = results[1] as PromiseFulfilledResult<any>;
      expect(read.value.summary.requests).toBeGreaterThanOrEqual(0);
      expect(facts.value.website.id).toBe(ids.website);
    }
  }, 10000);

  it('defers authorization when a foreground read starts in the same turn', async () => {
    const primary: any = getRawQueryClient(prisma.client, { write: true });
    const blockerClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 1 }),
    });
    let ready!: () => void, releaseLock!: () => void, releaseRead!: () => void;
    const readyPromise = new Promise<void>(resolve => {
      ready = resolve;
    });
    const lockPromise = new Promise<void>(resolve => {
      releaseLock = resolve;
    });
    const readPromise = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    const blocker = blockerClient.$transaction(
      async tx => {
        await tx.$executeRawUnsafe('LOCK TABLE liekan_ai_conversation IN ACCESS EXCLUSIVE MODE');
        ready();
        await lockPromise;
      },
      { timeout: 10000 },
    );
    await readyPromise;
    const analysis = buildAiFactsContext({
      actor: { id: ids.user, role: 'user' },
      conversationId: ids.conversation,
      input,
      signal: new AbortController().signal,
    });
    const foreground = withLogStatisticsRead(() => readPromise);
    const waiters = async () => {
      const [row] = await primary.$queryRawUnsafe(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='relation' AND query LIKE '%liekan_ai%' AND query LIKE '%FROM liekan_ai_conversation%'",
      );
      return row.n;
    };
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(await waiters()).toBe(0);
      releaseRead();
      await foreground;
      const deadline = Date.now() + 1500;
      let pending = 0;
      while (!pending && Date.now() < deadline) {
        pending = await waiters();
        if (!pending) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(pending).toBeGreaterThan(0);
    } finally {
      releaseRead();
      releaseLock();
      await foreground;
      await blocker;
      const facts = await analysis;
      await blockerClient.$disconnect();
      expect(facts.website.id).toBe(ids.website);
    }
  }, 10000);

  it('checks new foreground reads after acquiring a queued private connection', async () => {
    let ready!: () => void, releasePool!: () => void, releaseRead!: () => void;
    const readyPromise = new Promise<void>(resolve => {
      ready = resolve;
    });
    const poolPromise = new Promise<void>(resolve => {
      releasePool = resolve;
    });
    const readPromise = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    const blocker = getAiFactsClient().$transaction(
      async () => {
        ready();
        await poolPromise;
      },
      { timeout: 10000 },
    );
    await readyPromise;
    let finished = false;
    const result = buildAiFactsContext({
      actor: { id: ids.user, role: 'user' },
      conversationId: ids.conversation,
      input,
      signal: new AbortController().signal,
    }).then(value => {
      finished = true;
      return value;
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    const foreground = withLogStatisticsRead(() => readPromise);
    try {
      releasePool();
      await blocker;
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(finished).toBe(false);
    } finally {
      releaseRead();
      await foreground;
      const facts = await result;
      expect(facts.website.id).toBe(ids.website);
    }
  }, 10000);

  it('shares one five-second budget between foreground and private-pool waits', async () => {
    let ready!: () => void, releasePool!: () => void, releaseRead!: () => void;
    const readyPromise = new Promise<void>(resolve => {
      ready = resolve;
    });
    const poolPromise = new Promise<void>(resolve => {
      releasePool = resolve;
    });
    const readPromise = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    const blocker = getAiFactsClient().$transaction(
      async () => {
        ready();
        await poolPromise;
      },
      { timeout: 12000 },
    );
    await readyPromise;
    const foreground = withLogStatisticsRead(() => readPromise);
    const start = performance.now();
    const timer = setTimeout(releaseRead, 3000);
    try {
      await expect(
        buildAiFactsContext({
          actor: { id: ids.user, role: 'user' },
          conversationId: ids.conversation,
          input,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'facts_timeout' });
      const elapsedMs = performance.now() - start;
      console.log(JSON.stringify({ foregroundAndPoolWaitMs: elapsedMs }));
      expect(elapsedMs).toBeLessThan(6000);
    } finally {
      clearTimeout(timer);
      releaseRead();
      releasePool();
      await Promise.all([foreground, blocker]);
    }
    await expect(
      buildAiFactsContext({
        actor: { id: ids.user, role: 'user' },
        conversationId: ids.conversation,
        input,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ website: { id: ids.website } });
  }, 12000);
});
