// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  query: vi.fn(),
  totals: vi.fn(),
  context: vi.fn(),
  facts: vi.fn(),
  population: vi.fn(),
  metadata: vi.fn(),
}));
vi.mock('../warehouse/runtime', () => ({ warehouseEnabled: () => true }));
vi.mock('./server', async () => ({
  ...(await import('./errors')),
  query: m.query,
  humanTotals: m.totals,
}));
vi.mock('@/queries/sql', () => ({ getFunnel: vi.fn() }));
vi.mock('./analysis-rollups', () => ({ readAnalysisVisitContext: m.context }));
vi.mock('./warehouse-browser-queries', () => ({ warehouseBrowserFacts: m.facts }));
vi.mock('./warehouse-report-snapshot', () => ({ warehouseReportMetadata: m.metadata }));
vi.mock('./native-snapshot', () => ({ nativeSnapshot: (load: () => unknown) => load() }));
vi.mock('./browser-population', async importOriginal => ({
  ...(await importOriginal<typeof import('./browser-population')>()),
  readBrowserPopulation: m.population,
}));

import { getHumanDays, getHumanFacts } from './analytics';
import { populationFromRow } from './browser-population';

const start = new Date('2026-10-01T00:00:00Z');
const end = new Date('2026-10-02T00:00:00Z');
const population = (qualified: boolean) =>
  populationFromRow(
    {
      metricScope: 'qualified-browser',
      resourceKind: 'website',
      eligibleEvents: 3,
      eligiblePV: 3,
      qualifiedEvents: qualified ? 3 : 0,
      qualifiedPV: qualified ? 3 : 0,
      qualifiedIdentityVersions: qualified ? [1] : [],
      identityVersions: qualified ? [1] : [],
    },
    { startAt: +start, endAt: +end, timezone: 'UTC' },
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.query.mockRejectedValue(new Error('PostgreSQL fact reads are unavailable'));
  m.context.mockRejectedValue(new Error('PostgreSQL visit context is unavailable'));
  m.metadata.mockResolvedValue({ reports: [] });
  m.totals.mockResolvedValue({
    pageviews: 3,
    visitors: 1,
    visits: 1,
    bounces: 0,
    totaltime: 10,
    population: population(true),
  });
});

it('keeps crawler page facts on ClickHouse when PostgreSQL context projection is requested', async () => {
  m.facts.mockResolvedValue({ daily: [{ day: '2026-10-01', pv: 3 }], pages: [] });
  const facts = await getHumanFacts('site', start, end, 'UTC', ['daily', 'pages'], undefined, {
    crawlerContext: true,
  });
  expect(facts.daily).toEqual([{ day: '2026-10-01', pv: 3 }]);
  expect(facts.totals.pageviews).toBe(3);
  expect(m.facts).toHaveBeenCalledWith('site', start, end, 'UTC', ['daily', 'pages'], {
    geographyReadLimit: undefined,
  });
  expect(m.metadata).toHaveBeenCalledWith('site');
  expect(m.context).not.toHaveBeenCalled();
  expect(m.query).not.toHaveBeenCalled();
});

it.each([true, false])(
  'retains independent trend population with qualified identity %s',
  async qualified => {
    const evidence = population(qualified);
    m.population.mockResolvedValue(evidence);
    m.facts.mockResolvedValue({
      daily: [
        { day: '2026-10-01', pv: 3, uv: 1, sessions: 1, duration: 10, bounces: 0, conversions: 0 },
      ],
    });
    const trend = await getHumanDays('site', start, end, 'UTC', true);
    expect(trend.population).toBe(evidence);
    expect(trend.rows).toEqual([
      {
        day: '2026-10-01',
        pv: 3,
        uv: qualified ? 1 : null,
        sessions: qualified ? 1 : null,
        duration: qualified ? 10 : null,
        bounces: qualified ? 0 : null,
        conversions: qualified ? 0 : null,
      },
    ]);
    expect(m.facts).toHaveBeenCalledWith('site', start, end, 'UTC', ['daily'], { hour: true });
    expect(m.population).toHaveBeenCalledWith('site', start, end, 'UTC');
    expect(m.query).not.toHaveBeenCalled();
  },
);
