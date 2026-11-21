import { expect, it } from 'vitest';
import { parseReportQuery } from '../contracts/query';
import { adaptPreviousSnapshot, adaptPreviousRetention } from './warehouse-snapshot-compatibility';
const site = '11111111-1111-4111-8111-111111111111';
const parameters = () => {
  const p = parseReportQuery({
    resource: 'overview',
    chartPeriod: 'today',
    startAt: 1000,
    endAt: 2000,
    timezone: 'UTC',
  });
  if (!p.success) throw Error('fixture');
  return p.data;
};
const report = () => ({
  contractVersion: 2,
  resource: 'overview',
  website: { id: site, name: 'Fixture', domain: 'example.test' },
  range: { startAt: 1000, endAt: 2000, timezone: 'UTC' },
  states: { human: 'available', logs: 'available', catalog: 'available', goals: 'available' },
  cards: [],
  charts: {},
  tables: { topBody: [] },
  insights: [],
  meta: {
    demo: false,
    canManage: true,
    latestImportAt: null,
    ruleCount: 0,
    generatedAt: 2001,
    expiresAt: 3000,
    snapshot: { dataThrough: 2001, state: 'ready', intervalMs: 1800000 },
  },
  overviewRanking: { table: 'topBody', rows: [{ path: '/fixture', pv: 3 }] },
});
it('adapts only the supported validated old contract without mutating or relabeling it', () => {
  const saved = report(),
    original = structuredClone(saved);
  const adapted = adaptPreviousSnapshot(2, saved, parameters(), site);
  expect(adapted).toEqual(saved);
  expect(saved).toEqual(original);
  expect(adaptPreviousSnapshot(1, saved, parameters(), site)).toBeUndefined();
  expect(adaptPreviousSnapshot(4, saved, parameters(), site)).toBeUndefined();
});
it.each(['range', 'resource', 'website', 'snapshot', 'contract', 'cards'] as const)(
  'rejects incompatible %s instead of inventing a successful result',
  field => {
    const saved: any = report();
    if (field === 'range') saved.range.endAt++;
    if (field === 'resource') saved.resource = 'ai/pages';
    if (field === 'website') saved.website.id = '22222222-2222-4222-8222-222222222222';
    if (field === 'snapshot') delete saved.meta.snapshot;
    if (field === 'contract') saved.contractVersion = 1;
    if (field === 'cards') saved.cards = [{ label: 'invalid' }];
    expect(adaptPreviousSnapshot(2, saved, parameters(), site)).toBeUndefined();
  },
);
it('rejects invalid optional ranking artifacts while retaining the valid first page', () => {
  const saved = {
    ...report(),
    rankings: { build: 'invalid', counts: {} },
    overviewRanking: { table: 'another', rows: [] },
  };
  const value = adaptPreviousSnapshot(2, saved, parameters(), site);
  expect(value).toBeDefined();
  expect(value.rankings).toBeUndefined();
  expect(value.overviewRanking).toBeUndefined();
});
it('does not treat a malformed retention payload as a valid old array', () => {
  expect(
    adaptPreviousRetention(2, { kind: 'retention', rows: [], dataThrough: 1, population: {} }),
  ).toBeUndefined();
});
it.each([undefined, 1] as const)(
  'accepts the frozen-clock range, without pretending it includes the rest of the requested day (%s)',
  crawlerMetricsVersion => {
    const p = { ...parameters(), crawlerMetricsVersion },
      saved = report();
    saved.meta.snapshot.dataThrough = 1500;
    saved.range.endAt = crawlerMetricsVersion === 1 ? 1500 : 1499;
    expect(adaptPreviousSnapshot(2, saved, p, site)?.range).toEqual(saved.range);
    saved.range.endAt--;
    expect(adaptPreviousSnapshot(2, saved, p, site)).toBeUndefined();
    saved.range.endAt = 2000;
    expect(adaptPreviousSnapshot(2, saved, p, site)).toBeUndefined();
  },
);
