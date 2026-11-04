import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./warehouse-report-snapshot', () => ({ warehouseReportQuery: mocks.query }));
import {
  normalizeWarehouseInstallationObservation,
  warehouseInstallationObservation,
  warehouseInstallationObservationSql,
} from './warehouse-installation-observation';
beforeEach(() => vi.clearAllMocks());

it('reads the accepted raw public population with receipt fallback and no event-time restriction', async () => {
  mocks.query.mockResolvedValue([
    {
      samples: '2',
      available: '1',
      unknown: '1',
      fallback: '1',
      lastReceivedAt: '2026-10-27 09:29:59.999000',
    },
  ]);
  const signal = new AbortController().signal;
  const result = await warehouseInstallationObservation(
    'site',
    Date.parse('2026-10-27T09:00Z'),
    Date.parse('2026-10-27T09:30Z'),
    signal,
  );
  expect(result.lastReceivedAt.toISOString()).toBe('2026-10-27T09:29:59.999Z');
  expect(result).toMatchObject({ samples: 2, available: 1, unknown: 1, fallback: 1 });
  expect(mocks.query).toHaveBeenCalledWith(
    'site',
    expect.any(String),
    {
      receivedStart: '2026-10-27 09:00:00.000000',
      receivedEnd: '2026-10-27 09:30:00.000000',
    },
    { signal, timeoutSeconds: 1 },
  );
  const sql = warehouseInstallationObservationSql();
  expect(sql).toContain("q.source IN('browser','legacy_override')");
  expect(sql).toContain('coalesce(o.received_at,q.created_at)>={receivedStart:');
  expect(sql).toContain('coalesce(o.received_at,q.created_at)<{receivedEnd:');
  expect(sql).toContain('countIf(isNull(o.event_id))');
  expect(sql).toContain("isNull(env.event_id) OR empty(coalesce(env.identity_version,''))");
  expect(sql).toContain('warehouse_publication');
  expect(sql).toContain('warehouse_deletion');
  expect(sql).toContain('publication <= {wh_publication:UInt64}');
  expect(sql).not.toContain('e.created_at');
  expect(sql).not.toMatch(
    /liekan_browser_risk|liekan_traffic_exclusion|liekan_history_repair_result/,
  );
});

it.each([null, undefined, '', ' ', '9007199254740992', -1, 1.5, false, 'invalid'])(
  'rejects malformed CH counts instead of publishing zero (%s)',
  value => {
    expect(() =>
      normalizeWarehouseInstallationObservation({
        samples: value,
        available: '0',
        unknown: '0',
        fallback: '0',
        lastReceivedAt: null,
      }),
    ).toThrow('Invalid warehouse installation observation count');
  },
);

it('preserves absent or empty evidence for the caller to classify', async () => {
  mocks.query
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      { samples: 0, available: 0, unknown: 0, fallback: 0, lastReceivedAt: null },
    ]);
  const signal = new AbortController().signal;
  expect(await warehouseInstallationObservation('site', 0, 1, signal)).toBeUndefined();
  expect(await warehouseInstallationObservation('site', 0, 1, signal)).toMatchObject({
    samples: 0,
    lastReceivedAt: null,
  });
});
