import { expect, it, vi } from 'vitest';
import { calendarDayRange } from '../contracts/calendar';
import { parseReportQuery } from '../contracts/query';
const mocks = vi.hoisted(() => ({ browser: vi.fn(async () => ({})) }));
vi.mock('../warehouse/reader-runtime', () => ({
  warehouseReader: () => ({ db: { read: async () => [{ count: '0' }] } }),
}));
vi.mock('./warehouse-report-snapshot', () => ({ warehouseReportMetadata: async () => ({}) }));
vi.mock('./warehouse-browser-page-report', () => ({
  prepareWarehouseBrowserPageReport: mocks.browser,
}));
vi.mock('./warehouse-ai-page-report', () => ({ prepareWarehouseAiPageReport: vi.fn() }));
vi.mock('./logs', () => ({ getLogFacts: vi.fn() }));
import { prepareWarehousePageReport } from './warehouse-page-report';

it.each(['Asia/Shanghai', 'America/New_York'])(
  'only the canonical Today build computes the shared counter (%s)',
  async timezone => {
    // Covers the 25-hour DST calendar day as well as a fixed-offset day.
    const now = Date.parse('2026-11-01T18:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const day = calendarDayRange(now, timezone);
    const site = { id: 'fixture', domain: 'example.test' };
    const build = async (input: Record<string, unknown>, scheduled = true) => {
      const p = parseReportQuery({
        resource: 'overview',
        chartPeriod: 'today',
        ...day,
        timezone,
        ...input,
      });
      if (!p.success) throw new Error('invalid fixture');
      return prepareWarehousePageReport(site, p.data, scheduled);
    };
    try {
      expect((await build({})).sharedTodayRequests).toBe(false);
      expect((await build({ refresh: '1' })).sharedTodayRequests).toBe(false);
      expect(
        (await build({ chartPeriod: '7d', startAt: day.startAt - 7 * 86400000 }))
          .sharedTodayRequests,
      ).toBe(true);
      expect(
        (await build({ chartPeriod: '30d', startAt: day.startAt - 30 * 86400000 }))
          .sharedTodayRequests,
      ).toBe(true);
      expect((await build({ search: '/something' })).sharedTodayRequests).toBe(true);
      expect(
        (await build({ startAt: day.startAt - 86400000, endAt: day.startAt - 1 }))
          .sharedTodayRequests,
      ).toBe(true);
      // Legacy/on-demand export computation is unchanged.
      expect(
        (await build({ chartPeriod: '30d', startAt: day.startAt - 30 * 86400000 }, false))
          .sharedTodayRequests,
      ).toBe(false);
    } finally {
      clock.mockRestore();
    }
  },
);
