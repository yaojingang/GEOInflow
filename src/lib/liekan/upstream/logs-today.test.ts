// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./server', () => ({ query: vi.fn(), LiekanError: class extends Error {} }));
vi.mock('./analysis-rollups', () => ({ readAnalysisLogToday: vi.fn() }));
import { getLogToday } from './logs';
import { query } from './server';
import { readAnalysisLogToday } from './analysis-rollups';
const start = new Date('2026-10-26T16:00:00Z');
const end = new Date('2026-10-26T17:00:00.123Z');
beforeEach(() => vi.resetAllMocks());
it('combines covered event-time counts with independent inclusive import-time accepted counts', async () => {
  vi.mocked(readAnalysisLogToday).mockResolvedValue({
    requests: 13,
    abnormal: 4,
    coverage: { manifests: 2, rawFallback: true },
  });
  vi.mocked(query).mockResolvedValue([{ accepted: 79 }]);
  expect(await getLogToday('site', start, end)).toEqual({
    requests: 13,
    abnormal: 4,
    accepted: 79,
  });
  expect(readAnalysisLogToday).toHaveBeenCalledWith({
    websiteId: 'site',
    startDate: start,
    endDate: end,
  });
  expect(query).toHaveBeenCalledExactlyOnceWith(
    'SELECT coalesce(sum(accepted),0)::int AS accepted FROM liekan_import WHERE website_id=$1::uuid AND imported_at BETWEEN $2 AND $3',
    'site',
    start,
    end,
  );
});
it('retains the original reporting-log SQL for unsupported readers', async () => {
  vi.mocked(readAnalysisLogToday).mockResolvedValue(null);
  vi.mocked(query).mockImplementation(async statement =>
    statement.includes('FROM liekan_import') ? [{ accepted: 1 }] : [{ requests: 2, abnormal: 3 }],
  );
  expect(await getLogToday('site', start, end)).toEqual({ requests: 2, abnormal: 3, accepted: 1 });
  const raw = vi
    .mocked(query)
    .mock.calls.find(([statement]) => statement.includes('FROM liekan_reporting_log'));
  expect(raw[0]).toContain('created_at BETWEEN $2 AND $3');
  expect(raw.slice(1)).toEqual(['site', start, end]);
});
