import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./server', () => ({ query: vi.fn(), humanTotals: vi.fn() }));
vi.mock('@/queries/sql', () => ({ getFunnel: vi.fn() }));

import { getFunnel } from '@/queries/sql';
import { classifyEntrySource, getHumanFacts, humanVisitsSql } from './analytics';
import { withTrafficPolicy } from './traffic-query';
import { humanTotals, query } from './server';
import { readBrowserDetailFacts } from './browser-detail-facts';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readBrowserDetailFacts).mockResolvedValue(null);
});

describe('keyword visit projection', () => {
  it.each([true, false])('retains the default dimension projection with keywords=%s', keywords => {
    expect(humanVisitsSql(keywords)).toBe(humanVisitsSql(keywords, true));
    expect(() => withTrafficPolicy(humanVisitsSql(keywords, false))).not.toThrow();
  });
});

describe('content path projections', () => {
  const start = new Date('2026-01-01T00:00Z'),
    end = new Date('2026-01-08T00:00Z');
  const configure = () => {
    vi.mocked(humanTotals).mockResolvedValue({
      pageviews: 3,
      visitors: 1,
      visits: 1,
      bounces: 0,
      totaltime: 0,
    });
    vi.mocked(query).mockImplementation(async sql =>
      sql.includes('jsonb_build_object')
        ? [
            {
              facts: {
                journeys: [{ path: '/a → /b', count: 1 }],
                exits: [{ path: null, count: 1 }],
              },
            },
          ]
        : [],
    );
  };
  it.each([false, true])(
    'retains event ownership without unused visit or geography expansion when detail coverage is %s',
    async covered => {
      configure();
      if (covered) {
        vi.mocked(readBrowserDetailFacts).mockResolvedValue({ pages: [{ path: '/a', pv: 3 }] });
      }
      const actual = await getHumanFacts(
        'site',
        start,
        end,
        'UTC',
        covered ? ['pages', 'journeys', 'exits'] : ['journeys', 'exits'],
      );
      const [sql, ...parameters] = vi
        .mocked(query)
        .mock.calls.find(([sql]) => sql.includes('jsonb_build_object'));
      expect(sql).toContain('FROM liekan_effective_website_event e');
      expect(sql).not.toContain('bounded_history');
      expect(sql).not.toContain('JOIN session');
      expect(sql).not.toContain('visit_totals');
      expect(parameters).toEqual(['site', start, end, 'UTC']);
      expect(actual.journeys).toEqual([{ path: '/a → /b', count: 1 }]);
      expect(actual.exits).toEqual([{ path: null, count: 1 }]);
    },
  );
  it('retains the full visit query when another requested field has no detail coverage', async () => {
    configure();
    await getHumanFacts('site', start, end, 'UTC', ['pages', 'journeys', 'exits']);
    const [sql] = vi.mocked(query).mock.calls.find(([sql]) => sql.includes('jsonb_build_object'));
    expect(sql).not.toContain('liekan_event_geography');
    expect(sql).toContain('visit_totals');
  });
});

describe('visit entry attribution', () => {
  it('keeps generated direct traffic separate from a supplied source with the same name', async () => {
    vi.mocked(humanTotals).mockResolvedValue({
      pageviews: 10,
      visitors: 10,
      visits: 10,
      bounces: 0,
      totaltime: 0,
    });
    vi.mocked(query).mockImplementation(async sql =>
      sql.includes('jsonb_build_object')
        ? [
            {
              facts: {
                sources: [
                  { referrer: null, sessions: 3, pv: 3, duration: 10 },
                  { referrer: '直接访问', sessions: 7, pv: 7, duration: 20 },
                ],
              },
            },
          ]
        : [],
    );
    const facts = await getHumanFacts('site', new Date(0), new Date(1000), 'UTC', ['sources']);
    expect(facts.sources).toHaveLength(2);
    expect(facts.sources.find(row => row.sourceLabel === 'direct')).toMatchObject({
      source: '直接访问',
      sessions: 3,
      referrer: null,
    });
    expect(facts.sources.find(row => row.referrer === '直接访问')).toMatchObject({
      source: '直接访问',
      sessions: 7,
    });
    expect(facts.sources.find(row => row.referrer === '直接访问')).not.toHaveProperty(
      'sourceLabel',
    );
  });
  it('gives explicit UTM attribution priority and keeps unknown values conservative', () => {
    expect(classifyEntrySource({ utmSource: ' ChatGPT ', referrer: '' })).toEqual({
      source: 'chatgpt.com',
      channel: 'AI 搜索引荐',
    });
    expect(classifyEntrySource({ utmMedium: 'email', referrer: 'google.com' })).toEqual({
      source: 'UTM / email',
      channel: '其他引荐',
    });
    expect(
      classifyEntrySource({ utmSource: 'google', utmMedium: 'email', referrer: 'chatgpt.com' }),
    ).toEqual({ source: 'google.com', channel: '其他引荐' });
    expect(
      classifyEntrySource({ utmSource: 'google-not-a-real-source', referrer: 'google.com' }),
    ).toEqual({ source: 'google-not-a-real-source', channel: '其他引荐' });
    expect(classifyEntrySource({ utmSource: 'constructor', referrer: 'google.com' })).toEqual({
      source: 'constructor',
      channel: '其他引荐',
    });
    expect(classifyEntrySource({ utmCampaign: 'launch', referrer: 'www.google.com' })).toEqual({
      source: 'www.google.com',
      channel: '传统搜索',
    });
    expect(classifyEntrySource({ referrer: 'chatgpt.com.evil.example' })).toEqual({
      source: 'chatgpt.com.evil.example',
      channel: '其他引荐',
    });
    expect(classifyEntrySource({ referrer: 'app.perplexity.ai' })).toEqual({
      source: 'app.perplexity.ai',
      channel: 'AI 搜索引荐',
    });
    expect(classifyEntrySource({})).toEqual({ source: '直接访问', channel: '直接访问' });
  });
});
describe('saved funnel isolation', () => {
  const start = new Date('2026-01-01'),
    end = new Date('2026-01-02');
  const configure = (parameters: unknown) => {
    vi.mocked(humanTotals).mockResolvedValue({
      pageviews: 1,
      visitors: 1,
      visits: 1,
      bounces: 1,
      totaltime: 0,
    });
    vi.mocked(query).mockImplementation(async sql =>
      sql.includes('ORDER BY created_at LIMIT 100')
        ? [{ id: 'funnel', type: 'funnel', name: 'Saved funnel', parameters }]
        : [],
    );
  };
  it('keeps all human facts available when a stored funnel has a malformed step', async () => {
    configure({ window: 30, steps: [{ type: 'path', value: '/a' }, { type: 'event' }] });
    vi.mocked(getFunnel).mockRejectedValue(new Error('private upstream configuration'));
    const facts = await getHumanFacts('site', start, end, 'Asia/Shanghai');
    expect(humanTotals).toHaveBeenCalledWith('site', start, end, 'Asia/Shanghai');
    expect(facts.totals.pageviews).toBe(1);
    expect(facts).toMatchObject({
      funnel: [],
      funnelState: 'unsupported',
      funnelError: '已保存的漏斗配置无效，请检查目标配置',
    });
    expect(getFunnel).not.toHaveBeenCalled();
  });
  it('validates non-array steps and preserves the upstream calculation for valid saved funnels', async () => {
    configure({ window: 30, steps: 'invalid' });
    expect((await getHumanFacts('site', start, end, 'UTC')).funnelState).toBe('unsupported');
    configure({
      window: 30,
      steps: [
        { type: 'path', value: '/a' },
        { type: 'event', value: 'download' },
      ],
    });
    vi.mocked(getFunnel).mockResolvedValue([]);
    expect((await getHumanFacts('site', start, end, 'UTC')).funnelState).toBe('empty');
    expect(getFunnel).toHaveBeenCalledWith(
      'site',
      {
        window: 30,
        steps: [
          { type: 'path', value: '/a' },
          { type: 'event', value: 'download' },
        ],
        startDate: start,
        endDate: end,
      },
      { startDate: start, endDate: end },
    );
  });
  it('preserves saved configuration errors in lightweight page projections without querying funnels', async () => {
    configure({ window: 30, steps: [{ type: 'path', value: '/a' }, { type: 'event' }] });
    const facts = await getHumanFacts('site', start, end, 'UTC', ['pages']);
    expect(facts.funnelError).toBe('已保存的漏斗配置无效，请检查目标配置');
    expect(getFunnel).not.toHaveBeenCalled();
    configure({
      window: 30,
      steps: [
        { type: 'path', value: '/a' },
        { type: 'event', value: 'download' },
      ],
    });
    expect((await getHumanFacts('site', start, end, 'UTC', ['pages'])).funnelError).toBeNull();
    expect(getFunnel).not.toHaveBeenCalled();
  });
});
vi.mock('./browser-detail-facts', () => ({ readBrowserDetailFacts: vi.fn() }));
