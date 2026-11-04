// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { parseReportQuery } from '../contracts/query';
const mocks = vi.hoisted(() => ({ logs: vi.fn(), evidence: vi.fn() }));
vi.mock('./warehouse-log-queries', () => ({ warehouseLogFacts: mocks.logs }));
vi.mock('./warehouse-report-evidence', () => ({ warehouseReportEvidence: mocks.evidence }));
import { prepareWarehouseAiPageReport } from './warehouse-ai-page-report';

it('uses one current-day cutoff for log totals, complete evidence, and the prepared report', async () => {
  const cutoff = Date.parse('2026-11-03T04:00:00Z');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(cutoff);
  const dispose = vi.fn(async () => {});
  try {
    const parsed = parseReportQuery({
      resource: 'ai/pages',
      crawlerMetricsVersion: 1,
      startAt: Date.parse('2026-11-03T00:00:00Z'),
      endAt: Date.parse('2026-11-03T23:59:59Z'),
      timezone: 'UTC',
    });
    if (!parsed.success) throw new Error('invalid cutoff fixture');
    mocks.logs.mockImplementation(async () => {
      clock.mockReturnValue(cutoff + 2000);
      return { latest: new Date(cutoff) };
    });
    mocks.evidence.mockImplementation(async () => {
      clock.mockReturnValue(cutoff + 5000);
      return {
        source: { page: async () => [], dispose },
        pageSummary: { blind: { count: async () => 0, page: async () => [] } },
      };
    });
    const result = await prepareWarehouseAiPageReport('site', 'example.test', parsed.data);
    expect(+mocks.logs.mock.calls[0][2]).toBe(cutoff);
    expect(mocks.evidence.mock.calls[0][2].endAt).toBe(cutoff);
    expect(result.range.readEndAt).toBe(cutoff);
    expect(result.range.now).toBe(cutoff);
    expect(parsed.data.endAt).toBe(Date.parse('2026-11-03T23:59:59Z'));
    await result.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});
