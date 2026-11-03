// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  events: [] as string[],
  cursor: 0,
  pendingQuery: false,
  paused: false,
  stopped: false,
  served: 0,
  work: vi.fn(),
}));
vi.mock('./analysis-rollups-db', () => ({
  analysisCapacity: async () => ({globalBytes:'0',siteBytes:'0',globalLimit:8*1024**3,siteLimit:1024**3}),
  analysisTransaction: async (work: any) =>
    work({
      $executeRawUnsafe: async () => {
        h.served++;
        return 1;
      },
      $queryRawUnsafe: async () =>
        h.paused ? [] : [{ id: `site-${h.cursor++ % 2}`, actor_id: null }],
    }),
}));
vi.mock('./analysis-background', () => ({
  withAnalysisPermit: async (kind: string, work: any) => {
    if (kind === 'incremental' && h.pendingQuery) {
      h.events.push('yield');
      return { acquired: false };
    }
    h.events.push('acquire');
    try {
      return {
        acquired: true,
        value: await work(() => true, { token: 'fenced-token', epoch: '7' }),
      };
    } finally {
      h.events.push('release');
    }
  },
}));
vi.mock('./analysis-rollups-worker', () => ({
  runOneAnalysisWorkUnit: (...args: any[]) => h.work(...args),
}));
import { processAnalysisBuild } from './analysis-build-queue';
import { withAnalysisPermit } from './analysis-background';
describe('bounded fair build deliveries', () => {
  beforeEach(() => {
    h.events = [];
    h.cursor = 0;
    h.pendingQuery = false;
    h.paused = false;
    h.stopped = false;
    h.served = 0;
    h.work.mockReset().mockResolvedValue({ worked: true });
  });
  it('drains multiple short units with a fresh permit and bounded site rotation', async () => {
    await processAnalysisBuild('site-0', 'incremental');
    expect(h.work.mock.calls.length).toBeGreaterThan(1);
    expect(h.work.mock.calls.length).toBeLessThanOrEqual(32);
    expect(new Set(h.work.mock.calls.map(c => c[0])).size).toBe(2);
    for (let n = 0; n < h.events.length; n += 2)
      expect(h.events.slice(n, n + 2)).toEqual(['acquire', 'release']);
    expect(h.work.mock.calls.every(c => c[1].token === 'fenced-token' && c[1].epoch === '7')).toBe(
      true,
    );
  });
  it('does not advance site service times when admission is denied', async () => {
    h.pendingQuery = true;
    await processAnalysisBuild('stale-delivery', 'incremental');
    expect(h.served).toBe(0);
    expect(h.work).not.toHaveBeenCalled();
  });
  it('checks shutdown after each released unit', async () => {
    h.work.mockImplementation(async () => {
      h.stopped = true;
      return { worked: true };
    });
    await processAnalysisBuild('site-0', 'incremental', { shouldStop: () => h.stopped });
    expect(h.work).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual(['acquire', 'release']);
  });
  it('yields to a newly queued query before another incremental unit', async () => {
    h.work.mockImplementation(async () => {
      h.pendingQuery = true;
      return { worked: true };
    });
    await processAnalysisBuild('site-0', 'incremental');
    expect(h.work).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual(['acquire', 'release', 'yield']);
    expect((await withAnalysisPermit('interactive', async () => true)).acquired).toBe(true);
  });
  it('rechecks history repair admission after every short unit', async () => {
    h.work.mockImplementation(async () => {
      h.paused = true;
      return { worked: true };
    });
    await processAnalysisBuild('site-0', 'history');
    expect(h.work).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual(['acquire', 'release']);
  });
});
