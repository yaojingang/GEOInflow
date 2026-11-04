// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { browserPopulationSchema, identityEncodingChanged } from '../contracts/browser-population';
import {
  applyReportPopulation,
  identityEncodingChangeReason,
  qualifiedBrowserReason,
} from '../contracts/population-results';
import type { LiekanReport } from '../contracts/report';

const m = vi.hoisted(() => ({ query: vi.fn(), metadata: vi.fn() }));
vi.mock('../warehouse/runtime', () => ({ warehouseEnabled: () => true }));
vi.mock('./warehouse-report-snapshot', () => ({
  warehouseReportQuery: m.query,
  warehouseReportMetadata: m.metadata,
  withinWarehouseReport: (work: () => unknown) => work(),
}));

import { readBrowserPopulation } from './browser-population';

const oldVersion = 'cookieless-trusted-input-v3';
const currentVersion = 'cookieless-trusted-input-v4';
const start = new Date('2026-10-01T00:00:00Z');
const end = new Date('2026-11-01T00:00:00Z');
beforeEach(() => {
  vi.resetAllMocks();
  m.metadata.mockResolvedValue({ population: { resourceKind: 'website', policyRevision: '7' } });
});

it.each([true, false])(
  'exposes mixed identity encoding only when old-version pageviews are qualified: %s',
  async oldQualified => {
    m.query.mockResolvedValue([
      {
        eligibleEvents: 3,
        eligiblePV: 3,
        qualifiedEvents: oldQualified ? 3 : 2,
        qualifiedPV: oldQualified ? 3 : 2,
        qualifiedVisitors: oldQualified ? 3 : 2,
        identityVersions: [oldVersion, currentVersion],
        qualifiedIdentityVersions: oldQualified ? [oldVersion, currentVersion] : [currentVersion],
        ruleVersions: [],
        catalogVersions: [],
      },
    ]);
    const population = await readBrowserPopulation('site', start, end, 'UTC');
    // The accepted CH aggregate must project qualified PV versions independently
    // of all observed versions, including unqualified PV and custom events.
    expect(m.query.mock.calls[0][1]).toMatch(
      /groupUniqArrayIf\(identity_version,event_type IN\(1,3,4\) AND qualified AND identity_version IS NOT NULL\).* AS qualifiedIdentityVersions/,
    );
    expect(browserPopulationSchema.parse(population).identity.qualifiedVersions).toEqual(
      oldQualified ? [oldVersion, currentVersion] : [currentVersion],
    );
    expect(population.policyRevision).toBe('7');
    expect(identityEncodingChanged(population)).toBe(oldQualified);
    const report = applyReportPopulation(
      {
        meta: {},
        tables: {},
        charts: {},
        cards: [{ key: '访客数 UV', label: '访客数 UV', value: 3, state: 'available' }],
      } as LiekanReport,
      population,
    );
    expect(report.cards[0]).toMatchObject({
      value: 3,
      state: oldQualified ? 'estimated' : 'available',
      detail: oldQualified ? identityEncodingChangeReason : qualifiedBrowserReason,
    });
  },
);

it('keeps qualified version metadata bounded and advertises truncation', async () => {
  m.query.mockResolvedValue([
    {
      eligibleEvents: 33,
      eligiblePV: 33,
      qualifiedEvents: 33,
      qualifiedPV: 33,
      qualifiedVisitors: 33,
      identityVersions: [],
      qualifiedIdentityVersions: Array.from({ length: 33 }, (_, i) => `identity-version-${i}`),
      ruleVersions: [],
      catalogVersions: [],
    },
  ]);
  const population = await readBrowserPopulation('site', start, end, 'UTC');
  expect(population.identity.qualifiedVersions).toHaveLength(32);
  expect(population.versionSetsTruncated).toBe(true);
});
