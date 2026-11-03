import { expect, it } from 'vitest';
import { populationFromRow, applyNativePopulation } from '../upstream/browser-population';
import { identityComplete, identityUsable, browserPopulationSchema } from './browser-population';
import {
  applyReportPopulation,
  qualifiedBrowserReason,
  qualifiedBrowserUnavailableReason,
  identityEncodingChangeReason,
} from './population-results';
import { translateText } from '../i18n/text';

const metadata = (qualified = 3) =>
  populationFromRow(
    {
      resourceKind: 'website',
      metricScope: 'qualified-browser',
      eligibleEvents: 85,
      qualifiedEvents: qualified,
      eligiblePV: 83,
      qualifiedPV: qualified,
      qualifiedVisitors: qualified ? 2 : 0,
    },
    { startAt: 0, endAt: 1000, timezone: 'UTC' },
  );
const report = () =>
  ({
    meta: {},
    states: { human: 'available' },
    cards: [
      { key: '访客数 UV', value: 2, state: 'available' },
      { key: '浏览量 PV', value: 3, state: 'available' },
      { key: '跳出率', value: 50, state: 'available' },
      { key: '平均访问时长', value: 5, state: 'available' },
      { key: '新访客占比', value: 100, state: 'estimated' },
    ],
    charts: {
      h1: {
        series: [
          { name: 'PV', values: [3] },
          { name: 'UV', values: [2] },
        ],
      },
    },
    tables: {},
  }) as any;

it('retains coherent subset metrics and states their scope at partial coverage', () => {
  const population = browserPopulationSchema.parse(metadata());
  expect(identityUsable(population)).toBe(true);
  expect(identityComplete(population)).toBe(false);
  expect(
    applyNativePopulation(
      [{ pageviews: 3, visitors: 2, visits: 2, bounces: 1, totaltime: 10 }],
      'getWebsiteStats',
      population,
    )[0],
  ).toMatchObject({ visitors: 2, visits: 2, bounces: 1 });
  const result = applyReportPopulation(report(), population);
  expect(result.states.human).toBe('available');
  expect(result.cards.map(card => card.value)).toEqual([2, 3, 50, 5, 100]);
  expect(result.cards.every(card => card.detail === qualifiedBrowserReason)).toBe(true);
  expect(result.charts.h1.series.map(s => s.values)).toEqual([[3], [2]]);
});
it('shows missing identity explicitly without presenting an empty human population', () => {
  const population = metadata(0);
  expect(identityUsable(population)).toBe(false);
  const result = applyReportPopulation(report(), population);
  expect(result.states.human).toBe('unavailable');
  expect(result.cards.every(card => card.value === null && card.state === 'unavailable')).toBe(
    true,
  );
  expect(result.cards.every(card => card.detail === qualifiedBrowserUnavailableReason)).toBe(true);
  expect(result.charts.h1.series.map(s => s.values)).toEqual([[null], [null]]);
});
it('retains the legacy protection for responses without an explicit qualified scope', () => {
  const { metricScope, ...legacy } = metadata();
  expect(identityUsable(legacy)).toBe(false);
  expect(
    applyNativePopulation([{ pageviews: 83, visitors: 5 }], 'getWebsiteStats', legacy)[0],
  ).toMatchObject({ pageviews: 83, visitors: null });
});
it('translates scope and actionable missing-input explanations in English', () => {
  expect(translateText(qualifiedBrowserReason, 'en-US')).toContain('complete identity evidence');
  expect(translateText(qualifiedBrowserUnavailableReason, 'en-US')).toContain(
    'Check CLIENT_IP_HEADER',
  );
});

it('marks identity continuity as estimated only for qualified events spanning the encoding upgrade', () => {
  const population = metadata();
  population.identity.versions = ['cookieless-trusted-input-v3', 'cookieless-trusted-input-v4'];
  population.identity.qualifiedVersions = ['cookieless-trusted-input-v4'];
  expect(applyReportPopulation(report(), population).cards[0].state).toBe('available');
  population.identity.qualifiedVersions = [...population.identity.versions];
  const actual = applyReportPopulation(report(), population);
  expect(actual.cards[0]).toMatchObject({
    value: 2,
    state: 'estimated',
    detail: identityEncodingChangeReason,
  });
  expect(actual.cards[1]).toMatchObject({ value: 3, state: 'available' });
  expect(translateText(identityEncodingChangeReason, 'en-US')).toContain('encoding upgrade');
});
