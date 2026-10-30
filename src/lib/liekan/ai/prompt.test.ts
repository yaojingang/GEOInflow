import { describe, expect, it } from 'vitest';
import { validateAiAnswer } from './answer';
import type { AiFact, AiFactsContext } from './facts-contracts';
import { prepareAiPrompt } from './prompt';
import { callAiModel } from './model';
import { AI_TEMPLATES } from './templates';

const id = '00000000-0000-4000-8000-000000000001';
const context: AiFactsContext = {
  protocolVersion: 1,
  id,
  website: { id, name: '测试演示网站', domain: null },
  space: { kind: 'personal', id },
  websiteEpoch: id,
  currentRange: { startAt: '2026-10-01T00:00:00.000Z', endAt: '2026-10-03T23:59:59.999Z' },
  previousRange: { startAt: '2026-09-28T00:00:00.000Z', endAt: '2026-09-30T23:59:59.999Z' },
  timeZone: 'UTC',
  generatedAt: '2026-10-04T00:00:00.000Z',
  metricVersion: 'liekan-ai-facts-v1',
  promptVersion: 'liekan-ai-prompt-v1',
  coverage: 'unverified',
  rangeNotes: {
    originalEndAt: '2026-10-03T23:59:59.999Z',
    endClamped: false,
    currentDayIncomplete: false,
  },
  sourceStates: {
    human: 'empty',
    logs: 'not_connected',
    catalog: 'not_connected',
    goals: 'not_connected',
    aiReferrals: 'empty',
  },
  businessProfile: { state: 'unconfigured', value: null },
  metrics: [],
  facts: [],
};
const connectionConfig = {
  provider: 'custom',
  protocol: 'openai-chat',
  baseUrl: 'https://models.example.com/v1',
  model: 'test-demo',
};
const answer = {
  summary: '历史测试演示。',
  observations: [],
  possibleCauses: [],
  suggestions: [],
  limitations: [],
};
it('redacts sensitive data from both current and historical questions before external transmission', () => {
  const result = prepareAiPrompt({
    context,
    question: '联系 current@example.com token=current-private-value',
    history: [
      {
        state: 'completed',
        question: 'history@example.com password=history-private-value',
        answer,
        context,
      },
    ],
    connectionConfig,
  });
  expect(result.prompt).not.toMatch(
    /current@example\.com|history@example\.com|current-private-value|history-private-value/,
  );
  expect(result.prompt).toContain('[已脱敏]');
});
describe('AI actual serialized prompt budget', () => {
  it.each(['anthropic', 'openai'])(
    'includes protocol overhead for %s in each output/stream mode',
    async provider => {
      const config = AI_TEMPLATES.find(template => template.provider === provider)!;
      for (const stream of [false, true])
        for (const structuredOutput of [false, true]) {
          const prepared = prepareAiPrompt({
            context,
            question: '分析当前访问',
            history: [],
            connectionConfig: config,
            structuredOutput,
          });
          let captured = '';
          let requests = 0;
          await expect(
            callAiModel({
              connection: {
                provider: config.provider,
                protocol: config.protocol,
                base_url: config.baseUrl,
                model: config.model,
                capabilities: { keyVerified: { stream, structuredOutput } },
              } as any,
              apiKey: 'isolated-budget-fixture',
              system: prepared.system,
              prompt: prepared.prompt,
              maxOutputTokens: 2048,
              signal: new AbortController().signal,
              stream,
              jsonOutput: true,
              schema: structuredOutput ? prepared.schema : undefined,
              onText: () => {},
              fetch: (async (_url: unknown, init: any) => {
                requests++;
                captured = init.body;
                throw new Error('isolated-request-captured');
              }) as typeof fetch,
            }),
          ).rejects.toMatchObject({ code: 'protocol' });
          expect(requests).toBe(1);
          expect(Buffer.byteLength(captured, 'utf8')).toBeGreaterThan(0);
          expect(Buffer.byteLength(captured, 'utf8')).toBeLessThanOrEqual(prepared.inputBytes);
        }
    },
  );
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'bounds actual SDK request bytes with stream=%s and structured=%s',
    async (stream, structuredOutput) => {
      const config = {
        provider: 'deepseek',
        protocol: 'openai-chat' as const,
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
      };
      const prepared = prepareAiPrompt({
        context,
        question: '分析当前访问',
        history: [],
        connectionConfig: config,
        structuredOutput,
      });
      let requests = 0;
      const text = JSON.stringify(answer);
      const result = await callAiModel({
        connection: {
          provider: config.provider,
          protocol: config.protocol,
          base_url: config.baseUrl,
          model: config.model,
          capabilities: { documented: { usage: true }, keyVerified: { stream, structuredOutput } },
        } as any,
        apiKey: 'isolated-budget-fixture',
        system: prepared.system,
        prompt: prepared.prompt,
        maxOutputTokens: 2048,
        signal: new AbortController().signal,
        stream,
        jsonOutput: true,
        schema: structuredOutput ? prepared.schema : undefined,
        onText: () => {},
        fetch: (async (_url: unknown, init: any) => {
          requests++;
          expect(Buffer.byteLength(init.body, 'utf8')).toBeLessThanOrEqual(prepared.inputBytes);
          expect(JSON.parse(init.body).response_format.type).toBe(
            structuredOutput ? 'json_schema' : 'json_object',
          );
          if (!stream)
            return Response.json({
              choices: [
                { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
              ],
            });
          return new Response(
            [
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}`,
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
              'data: [DONE]',
            ].join('\n\n') + '\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }) as typeof fetch,
      });
      expect(requests).toBe(1);
      expect(result.text).toBe(text);
    },
  );
  it('fits all six mandatory facts without a schema mode the connection has not verified', () => {
    const current: AiFactsContext = {
      ...context,
      website: { id, name: '测试演示网站', domain: 'demo.example.com' },
      metrics: [
        { key: 'pageviews', label: '浏览量', value: 125, state: 'available', changePercent: 12.5 },
        { key: 'visitors', label: '访客数', value: 82, state: 'available', changePercent: 5.2 },
        { key: 'visits', label: '访问次数', value: 96, state: 'available', changePercent: 7.1 },
        { key: 'aiRequests', label: 'AI 抓取', value: 64, state: 'available', changePercent: 10.3 },
        { key: 'aiReferrals', label: 'AI 引荐', value: 3, state: 'available', changePercent: null },
      ],
      facts: [
        {
          id: 'summary',
          label: '统计汇总',
          state: 'available',
          data: {
            current: { pageviews: 125, visitors: 82, visits: 96 },
            previous: { pageviews: 111, visitors: 78, visits: 90 },
            changePercent: { pageviews: 12.5, visitors: 5.2, visits: 7.1 },
            logs: { requests: 100, aiRequests: 64, errors403: 4, errors404: 3, errors5xx: 1 },
            previousLogs: {
              requests: 90,
              aiRequests: 58,
              errors403: 3,
              errors404: 2,
              errors5xx: 0,
            },
            scope: 'human browser events and imported server logs',
          },
        },
        {
          id: 'bots',
          label: 'AI 爬虫',
          state: 'available',
          data: {
            total: 1,
            omitted: 0,
            truncated: false,
            requests: 64,
            previousRequests: 58,
            changePercent: 10.3,
            rows: [
              {
                name: '测试爬虫',
                vendor: '测试供应商',
                class: '搜索',
                verification: 'unverified',
                requests: 64,
                previousRequests: 58,
                changePercent: 10.3,
              },
            ],
            scope: 'AI classes: 训练, 搜索, 用户触发; UA classification with verification states',
          },
        },
        {
          id: 'log-errors',
          label: '异常请求',
          state: 'available',
          data: {
            total: 1,
            omitted: 0,
            truncated: false,
            requests: 8,
            previousRequests: 5,
            current: { requests: 100, errors403: 4, errors404: 3, errors5xx: 1 },
            previous: { requests: 90, errors403: 3, errors404: 2, errors5xx: 0 },
            changePercent: 60,
            paths: [{ path: '/sample', statusGroup: '404', requests: 3 }],
            samples: [],
            sampleTotal: 0,
            samplesOmitted: 0,
            samplesTruncated: false,
            sampleMethod: 'latest_by_created_at_desc_id_desc',
            scope:
              'imported logs: HTTP 403, 404 and 500–599; current and previous aggregate counts; paths and latest samples from current period; coverage unverified',
          },
        },
        {
          id: 'ai-referrals',
          label: 'AI 引荐',
          state: 'available',
          data: {
            visits: 3,
            pageviews: 4,
            previousVisits: 0,
            previousPageviews: 0,
            changePercent: null,
            scope: 'first browser pageview attribution using the approved AI channel catalog',
          },
        },
        {
          id: 'pages',
          label: '抓取页面',
          state: 'available',
          data: {
            total: 1,
            omitted: 0,
            truncated: false,
            rows: [
              {
                path: '/sample',
                humanPageviews: 125,
                previousHumanPageviews: 111,
                aiRequests: 64,
                previousAiRequests: 58,
              },
            ],
            scope:
              'browser paths and encoded imported AI request paths; union of current and previous periods ranked by current then previous counts; stored forms may differ; query and fragment excluded',
          },
        },
        {
          id: 'goals',
          label: '转化目标',
          state: 'not_connected',
          data: {
            total: 0,
            omitted: 0,
            truncated: false,
            configured: 0,
            invalidDefinitions: 0,
            rows: [],
            scope:
              'configured goal matching events; rates use converted browser visits divided by browser visits',
          },
        },
      ],
    };
    const result = prepareAiPrompt({
      context: current,
      question: '分析最近 7 天的 AI 抓取趋势',
      history: [],
      connectionConfig: {
        provider: 'deepseek',
        protocol: 'openai-chat',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
      },
    });
    expect(result.contextSent.facts).toEqual(current.facts);
    expect(result.contextSent.metrics).toEqual(current.metrics);
    expect(result.trimmed).toEqual({ historyTurns: 0, logSamples: 0, topRows: 0 });
    expect(result.inputBytes).toBeLessThanOrEqual(12697);
    expect(JSON.parse(result.prompt).responseSchema).toHaveProperty('properties.summary');
    const structured = prepareAiPrompt({
      context: current,
      question: '分析最近 7 天的 AI 抓取趋势',
      history: [],
      connectionConfig,
      structuredOutput: true,
    });
    expect(structured.contextSent.facts).toEqual(current.facts);
    expect(structured.inputBytes).toBeLessThanOrEqual(12697);
    expect(JSON.parse(structured.prompt).responseSchema).toBeUndefined();
    expect(structured.schema).toBeDefined();
  });
  it('keeps vague questions in the complete JSON contract with current fact references', () => {
    const current: AiFactsContext = {
      ...context,
      facts: [
        {
          id: 'pages',
          label: '当前页面',
          state: 'available',
          data: {
            total: 1,
            omitted: 0,
            truncated: false,
            rows: [],
            scope:
              'browser paths and encoded imported AI request paths; union of current and previous periods ranked by current then previous counts; stored forms may differ; query and fragment excluded',
          },
        },
      ],
    };
    const prepared = prepareAiPrompt({
      context: current,
      question: '试试',
      history: [],
      connectionConfig,
    });
    const payload = JSON.parse(prepared.prompt);
    expect(payload.question).toBe('试试');
    expect(prepared.system).toContain('意图不明确');
    expect(prepared.system).toContain('JSON');
    expect(
      validateAiAnswer(payload.responseExample, prepared.allowedContexts).observations[0].refs,
    ).toEqual([{ contextId: current.id, factId: 'pages' }]);
  });
  it('provides a valid complete example when no facts are available', () => {
    const prepared = prepareAiPrompt({ context, question: '你好', history: [], connectionConfig });
    const example = JSON.parse(prepared.prompt).responseExample;
    expect(validateAiAnswer(example, prepared.allowedContexts).observations).toEqual([]);
    expect(Object.keys(example)).toEqual([
      'summary',
      'observations',
      'possibleCauses',
      'suggestions',
      'limitations',
    ]);
  });
  it('sends only six complete authorized turns and bases references on their actual contexts', () => {
    const history = Array.from({ length: 8 }, (_, n) => ({
      state: 'completed' as const,
      question: `q${n}`,
      answer,
      context: { ...context, id: `00000000-0000-4000-8000-${String(n + 10).padStart(12, '0')}` },
    }));
    history.push({ ...history[0], state: 'failed' as any });
    const result = prepareAiPrompt({
      context,
      question: '分析当前访问',
      history,
      connectionConfig: {
        provider: 'kimi',
        protocol: 'openai-chat',
        baseUrl: 'https://api.moonshot.cn/v1',
        model: 'kimi-k3',
      },
    });
    const payload = JSON.parse(result.prompt);
    expect(payload.history).toHaveLength(6);
    expect(payload.history[0].question).toBe('q2');
    expect(result.allowedContexts.map(c => c.id)).toEqual([
      id,
      ...history.slice(2, 8).map(h => h.context.id),
    ]);
  });
  it('drops oldest whole history before data rows and enforces UTF-8 plus token headroom', () => {
    const history = Array.from({ length: 6 }, (_, n) => ({
      state: 'completed' as const,
      question: '历史中文'.repeat(500),
      answer,
      context: { ...context, id: `00000000-0000-4000-8000-${String(n + 10).padStart(12, '0')}` },
    }));
    const result = prepareAiPrompt({
      context,
      question: '问题保持完整',
      history,
      connectionConfig,
    });
    expect(result.inputBytes).toBeLessThanOrEqual(32768);
    expect(result.estimatedInputTokens + 2048).toBeLessThanOrEqual(Math.floor(16384 * 0.9));
    expect(JSON.parse(result.prompt).question).toBe('问题保持完整');
    expect(result.trimmed.historyTurns).toBeGreaterThan(0);
    expect(() =>
      prepareAiPrompt({ context, question: '中'.repeat(6000), history: [], connectionConfig }),
    ).toThrow(expect.objectContaining({ code: 'input_budget' }));
  });
});
const largeRowContext: AiFactsContext = {
  ...context,
  metrics: [
    { key: 'visitors', label: '人类访客', value: 4, state: 'available', changePercent: null },
  ],
  facts: [
    {
      id: 'log-errors',
      label: 'test-demo',
      state: 'available',
      data: {
        total: 100,
        omitted: 80,
        truncated: true,
        requests: 100,
        previousRequests: 0,
        current: { requests: 100, errors403: 100, errors404: 0, errors5xx: 0 },
        previous: { requests: 0, errors403: 0, errors404: 0, errors5xx: 0 },
        changePercent: null,
        paths: Array.from({ length: 20 }, (_, n) => ({
          path: `/test-demo/${n}/${'a'.repeat(420)}`,
          statusGroup: '403' as const,
          requests: 1,
        })),
        samples: Array.from({ length: 20 }, (_, n) => ({
          time: '2026-10-02T00:00:00.000Z',
          path: `/test-demo/${n}/${'a'.repeat(420)}`,
          status: 403,
          bot: 'test-demo',
        })),
        sampleTotal: 100,
        samplesOmitted: 80,
        samplesTruncated: true,
        sampleMethod: 'latest_by_created_at_desc_id_desc',
        scope:
          'imported logs: HTTP 403, 404 and 500–599; current and previous aggregate counts; paths and latest samples from current period; coverage unverified',
      },
    },
    {
      id: 'pages',
      label: 'test-demo',
      state: 'available',
      data: {
        total: 200,
        omitted: 180,
        truncated: true,
        rows: Array.from({ length: 20 }, (_, n) => ({
          path: `/test-demo/${n}/${'b'.repeat(420)}`,
          humanPageviews: 10,
          previousHumanPageviews: 0,
          aiRequests: 1,
          previousAiRequests: 0,
        })),
        scope:
          'browser paths and encoded imported AI request paths; union of current and previous periods ranked by current then previous counts; stored forms may differ; query and fragment excluded',
      },
    },
  ],
};

it('trims whole samples before whole TopN rows and preserves full aggregates and original question', () => {
  const large = largeRowContext;
  const history = Array.from({ length: 6 }, (_, n) => ({
    state: 'completed',
    question: 'test-demo-history',
    answer,
    context: { ...context, id: `00000000-0000-4000-8000-${String(n + 10).padStart(12, '0')}` },
  }));
  const result = prepareAiPrompt({
    context: large,
    question: '保留完整问题',
    history,
    connectionConfig,
  });
  expect(result.trimmed.historyTurns).toBe(6);
  expect(result.trimmed.logSamples).toBe(20);
  expect(result.trimmed.topRows).toBeGreaterThan(0);
  const pages = result.contextSent.facts.find(f => f.id === 'pages');
  if (pages?.id === 'pages') {
    expect(pages.data.total).toBe(200);
    expect(pages.data.omitted).toBe(200 - pages.data.rows.length);
    expect(
      pages.data.rows.every(row => row.path && row.aiRequests === 1 && row.humanPageviews === 10),
    ).toBe(true);
  }
  expect(JSON.parse(result.prompt).question).toBe('保留完整问题');
  expect(result.contextSent.metrics[0].value).toBe(4);
  expect(result.allowedContexts.map(c => c.id)).toEqual([context.id]);
  expect(large.facts[0].id === 'log-errors' && large.facts[0].data.samples.length).toBe(20);
});

it.each([
  ['pages', '哪些页面值得优先优化？'],
  ['pages', 'Which pages should I optimize?'],
  ['pages', '哪些 AI 抓取页面需要先优化？'],
  ['log-errors', '排查异常日志中的 404 错误'],
  ['log-errors', 'Check the 404 error logs'],
] as const)(
  'keeps relevant %s detail when clipping a large facts snapshot for %s',
  (factId, question) => {
    const prepared = prepareAiPrompt({
      context: largeRowContext,
      question,
      history: [],
      connectionConfig,
    });
    const fact = prepared.contextSent.facts.find(fact => fact.id === factId);
    if (!fact || (fact.id !== 'pages' && fact.id !== 'log-errors'))
      throw Error('Expected topic facts');
    const rows = fact.id === 'pages' ? fact.data.rows : fact.data.paths;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].path).toContain('/test-demo/0/');
    expect(fact.data.total).toBe(fact.id === 'pages' ? 200 : 100);
    expect(fact.data.omitted).toBe(fact.data.total - rows.length);
    expect(prepared.trimmed.topRows).toBeGreaterThan(0);
    expect(prepared.inputBytes).toBeLessThanOrEqual(12697);
    expect(JSON.parse(prepared.prompt).question).toBe(question);
    expect(prepared.contextSent.metrics).toEqual(largeRowContext.metrics);
    expect(largeRowContext.facts.find(fact => fact.id === 'pages')?.data.rows).toHaveLength(20);
  },
);

it.each([
  ['bots', '分析 AI 爬虫抓取趋势'],
  ['bots', 'Analyze crawler trends'],
  ['goals', '分析转化目标表现'],
  ['goals', 'Analyze conversion goals'],
] as const)('preserves %s detail before unrelated log rows for %s', (factId, question) => {
  const name = (index: number) => `test-demo ${'scope '.repeat(25)}${index}`;
  const selected: AiFact =
    factId === 'bots'
      ? {
          id: 'bots',
          label: 'test-demo',
          state: 'available',
          data: {
            total: 20,
            omitted: 0,
            truncated: false,
            requests: 120,
            previousRequests: 100,
            changePercent: 20,
            rows: Array.from({ length: 20 }, (_, index) => ({
              name: name(index),
              vendor: 'test-demo',
              class: '搜索',
              verification: 'unverified',
              requests: 6,
              previousRequests: 5,
              changePercent: 20,
            })),
            scope: 'AI classes: 训练, 搜索, 用户触发; UA classification with verification states',
          },
        }
      : {
          id: 'goals',
          label: 'test-demo',
          state: 'available',
          data: {
            total: 20,
            omitted: 0,
            truncated: false,
            configured: 20,
            invalidDefinitions: 0,
            rows: Array.from({ length: 20 }, (_, index) => ({
              name: name(index),
              type: 'path',
              count: 6,
              previousCount: 5,
              convertedVisits: 2,
              previousConvertedVisits: 2,
              ratePercent: 50,
              previousRatePercent: 50,
              changePercent: 20,
            })),
            scope:
              'configured goal matching events; rates use converted browser visits divided by browser visits',
          },
        };
  const prepared = prepareAiPrompt({
    context: { ...largeRowContext, facts: [largeRowContext.facts[0], selected] },
    question,
    history: [],
    connectionConfig,
  });
  const fact = prepared.contextSent.facts.find(fact => fact.id === factId);
  if (!fact || (fact.id !== 'goals' && fact.id !== 'bots')) throw Error('Expected topic facts');
  expect(fact.data.rows.length).toBeGreaterThan(0);
  expect(fact.data.rows.length).toBeLessThan(20);
  expect(fact.data.rows[0].name).toBe(name(0));
  expect(fact.data.total).toBe(20);
  expect(fact.data.omitted).toBe(20 - fact.data.rows.length);
  expect(fact.data.truncated).toBe(true);
  expect(prepared.contextSent.facts.find(fact => fact.id === 'log-errors')?.data.paths).toEqual([]);
  expect(prepared.trimmed.topRows).toBeGreaterThan(0);
  expect(prepared.inputBytes).toBeLessThanOrEqual(12697);
  expect(selected.data.rows).toHaveLength(20);
});

it('excludes credential query values embedded in outbound website labels', () => {
  const prepared = prepareAiPrompt({
    context: {
      ...context,
      website: {
        ...context.website,
        name: 'goal /callback?access_token=canarySecretValue#private-fragment',
      },
    },
    question: 'Compare traffic',
    history: [],
    connectionConfig,
  });
  expect(prepared.prompt).not.toContain('canarySecretValue');
  expect(prepared.prompt).not.toContain('private-fragment');
});

it('instructs new English answers while preserving raw website, question, facts and history', () => {
  const question = '请分析 页面访问';
  const history = [
    {
      state: 'completed',
      context,
      question: '旧问题',
      answer: { ...answer, summary: '历史回答保持原样' },
    },
  ];
  const prepared = prepareAiPrompt({
    context,
    question,
    history,
    connectionConfig,
    locale: 'en-US',
  });
  expect(prepared.system).toMatch(/English/);
  expect(prepared.system).toContain('Possible:');
  expect(prepared.prompt).toContain(question);
  expect(prepared.prompt).toContain('测试演示网站');
  expect(prepared.prompt).toContain('历史回答保持原样');
});

it('preserves ordinary multiline questions while applying outbound redaction', () => {
  const prepared = prepareAiPrompt({
    context,
    question: 'Compare traffic\nExplain changes\tthis week',
    history: [],
    connectionConfig,
  });
  expect(JSON.parse(prepared.prompt).question).toBe('Compare traffic Explain changes this week');
});
