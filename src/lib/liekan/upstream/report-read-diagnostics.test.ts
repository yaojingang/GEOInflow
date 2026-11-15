import { expect, it, vi } from 'vitest';
import {
  withReadDiagnostics,
  traceWarehouseRead,
  traceReadAuthorization,
  traceSerialization,
  noteReadRetry,
} from './report-read-diagnostics';
import { isWarehouseReportRequest } from './warehouse-report-scope';
import { sessionBoundaryScope } from './warehouse-session-boundary';

it('records bounded query IDs and timings without SQL, parameters or response content', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    const response = await withReadDiagnostics(async () => {
      await traceReadAuthorization(async () => true);
      for (let i = 0; i < 35; i++)
        await traceWarehouseRead(
          dispatch => dispatch(),
          async id => {
            expect(id).toMatch(/^liekan-read-/);
            return 'private visitor value';
          },
        );
      noteReadRetry();
      return traceSerialization(async () =>
        Response.json({ private: 'do not log' }, { headers: { 'X-Liekan-Cache': 'miss' } }),
      );
    });
    expect(response.headers.get('Server-Timing')).toContain('read-queries;desc="35"');
    const entry = JSON.parse(output.mock.calls[0][0]);
    expect(entry).toMatchObject({ queries: 35, retries: 1, cache: 'miss', status: 200 });
    expect(entry.queryIds).toHaveLength(32);
    expect(JSON.stringify(entry)).not.toMatch(/private|visitor|do not log/);
    expect(response.headers.get('X-Liekan-Read-Id')).toBe(entry.id);
  } finally {
    output.mockRestore();
  }
});

it('pins only the enumerated warehouse GET reads', () => {
  for (const suffix of ['sessions', 'retention', 'realtime'])
    expect(isWarehouseReportRequest(new Request(`http://local/api/websites/site/${suffix}`))).toBe(
      true,
    );
  for (const suffix of ['page-report', 'log-entries', 'overview-jobs/job/result'])
    expect(
      isWarehouseReportRequest(new Request(`http://local/api/liekan/websites/site/${suffix}`)),
    ).toBe(true);
  for (const path of [
    '/api/send',
    '/api/liekan/websites/site/settings',
    '/api/liekan/websites/site/overview-jobs/job/other',
  ])
    expect(isWarehouseReportRequest(new Request(`http://local${path}`))).toBe(false);
  expect(
    isWarehouseReportRequest(
      new Request('http://local/api/websites/site/sessions', { method: 'POST' }),
    ),
  ).toBe(false);
});

it('keeps session pages in one scope, but changes the handle scope for filters and sorting', () => {
  const initial = { startAt: 1, endAt: 2, timezone: 'UTC', page: 1, search: 'a' };
  expect(sessionBoundaryScope({ ...initial, page: 2, readBoundary: 'token' })).toBe(
    sessionBoundaryScope(initial),
  );
  expect(sessionBoundaryScope({ ...initial, search: 'b' })).not.toBe(sessionBoundaryScope(initial));
  expect(sessionBoundaryScope({ ...initial, orderBy: 'views' })).not.toBe(
    sessionBoundaryScope(initial),
  );
});
