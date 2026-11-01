import { expect, it } from 'vitest';
import { crawlerDirectory } from '../crawlers/directory';
import type { CrawlerAnalysisResponse } from './crawler-analysis';
import type { RobotsManagement } from './robots-management';
import { robotsOverview, robotsOverviewRange, robotsPublicUrl } from './robots-overview';
const state = (
  content: string | null = 'User-agent: *\nAllow: /',
  status: number | null = 200,
): RobotsManagement => ({
  hostname: 'example.com',
  draft: 'User-agent: *\nDisallow: /',
  revision: 1,
  monitor: false,
  interval: 60,
  checkedAt: '2026-10-31T00:00:00Z',
  observedContent: content,
  observedHostname: status === null ? null : 'example.com',
  observedStatus: status,
  lastError: null,
  changePending: false,
  agent: { connected: false, seenAt: null, path: null, contextValid: false },
  permissions: { canDraft: true, canControl: true },
  snapshots: [],
  deployments: [],
});
const analysis = (quality = 'complete', pages: any[] = []): CrawlerAnalysisResponse =>
  ({
    quality: { state: quality },
    directory: crawlerDirectory,
    bots: [{ botId: 'gptbot', name: 'GPTBot', requests: 10, denied403429: 3 }],
    pages,
    criticalPaths: [],
    range: { startAt: 1000, endAt: 2000, timezone: 'Asia/Shanghai' },
    generatedAt: '2026-10-31T00:00:00Z',
  }) as any;
it('uses the actual online snapshot and keeps unread and missing states distinct', () => {
  const unread = robotsOverview(state(null, null));
  expect(unread.fileState).toBe('not_checked');
  expect(unread.groups).toBeNull();
  const missing = robotsOverview(state(null, 404));
  expect(missing.fileState).toBe('missing');
  expect(missing.advice.map(a => a.id)).toContain('missing');
  const empty = robotsOverview(state(''));
  expect(empty.fileState).toBe('available');
  expect(empty.groups).toBe(0);
});
it('rejects stale domain snapshots as advice input', () => {
  const data = state('User-agent: *\nDisallow: /');
  data.observedHostname = 'old.example.com';
  const result = robotsOverview(
    data,
    analysis('complete', [
      { botId: 'gptbot', path: '/', requests: 10, successfulGets: 10, denied403429: 0 },
    ]),
  );
  expect(result.fileState).toBe('not_checked');
  expect(result.samples).toHaveLength(0);
});
it('explains allowed paths with HTTP denials without attributing the cause to robots', () => {
  const result = robotsOverview(
    state(),
    analysis('complete', [
      { botId: 'gptbot', path: '/docs', requests: 10, successfulGets: 7, denied403429: 3 },
    ]),
  );
  expect(result.advice.find(a => a.id === 'http')?.values).toEqual([3]);
  expect(result.samples[0].allowed).toBe(true);
});
it('labels current disallow versus historical successes and configured critical paths', () => {
  const logs = analysis('complete', [
    { botId: 'gptbot', path: '/private', requests: 10, successfulGets: 10, denied403429: 0 },
  ]);
  logs.bots.push({ botId: 'googlebot', requests: 1 } as any);
  logs.criticalPaths = ['/private'];
  const result = robotsOverview(state('User-agent: *\nDisallow: /private'), logs);
  expect(result.advice.find(a => a.id === 'history')?.values).toEqual([10]);
  expect(result.advice.find(a => a.id === 'critical')?.values).toEqual([1]);
});
it('keeps missing and unknown input separate from proved zero requests', () => {
  for (const quality of ['missing', 'unknown', 'unsupported']) {
    const logs = analysis(quality);
    logs.bots = [];
    const result = robotsOverview(state(), logs);
    expect(result.requests).toBeNull();
    expect(result.advice.map(a => a.id)).not.toContain('zero');
  }
  const logs = analysis();
  logs.bots = [];
  expect(robotsOverview(state(), logs).requests).toBe(0);
  expect(robotsOverview(state(), logs).advice.map(a => a.id)).toContain('zero');
});
it('does not claim user-triggered retrieval violated a robots rule', () => {
  const result = robotsOverview(
    state('User-agent: *\nDisallow: /'),
    analysis('complete', [
      { botId: 'chatgpt-user', path: '/', requests: 3, successfulGets: 3, denied403429: 0 },
    ]),
  );
  expect(result.samples).toHaveLength(0);
  expect(result.advice.map(a => a.id)).not.toContain('history');
});
it('keeps malformed files available for manual review without invented rule conclusions', () => {
  const result = robotsOverview(
    state('Malformed record'),
    analysis('complete', [
      { botId: 'gptbot', path: '/', requests: 5, successfulGets: 5, denied403429: 0 },
    ]),
  );
  expect(result.advice.map(a => a.id)).toContain('syntax');
  expect(result.samples).toHaveLength(0);
});
it('builds an explicit HTTPS file address and bounds the statistical window', () => {
  expect(robotsPublicUrl('www.example.com')).toBe('https://www.example.com/robots.txt');
  expect(() => robotsPublicUrl('evil.example/path')).toThrow();
  const now = 200 * 86400000;
  expect(robotsOverviewRange({ startAt: 0, endAt: now + 1000, timezone: 'UTC' }, now)).toEqual({
    startAt: now - 90 * 86400000,
    endAt: now,
    timezone: 'UTC',
  });
});
