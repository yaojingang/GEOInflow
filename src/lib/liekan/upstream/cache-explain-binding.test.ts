import { describe, expect, it } from 'vitest';
import {
  heavyExplainBindingAllowed,
  heavyExplainCoveragePassed,
  rememberHeavyExplainVersions,
} from '../../../../scripts/liekan-cache-explain';
import { ANALYSIS_ROLLUP_VERSION } from './analysis-rollups-model';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';
import { CRAWLER_POPULATION_VERSION } from '../rules/population';

const ownedSite = '10000000-0000-4000-8000-000000000001';
const allowed = new Set(['', ownedSite, 'Asia/Shanghai']);

describe('heavy EXPLAIN evidence binding boundary', () => {
  it.each([ANALYSIS_ROLLUP_VERSION, TRAFFIC_POLICY_VERSION, CRAWLER_POPULATION_VERSION])(
    'accepts the production version %s needed by actual rollup reads',
    value => expect(heavyExplainBindingAllowed(value, allowed)).toBe(true),
  );
  it.each([
    null,
    false,
    123,
    new Date('2026-10-01'),
    ownedSite,
    '/synthetic/1',
    'synthetic-agent',
    ['synthetic-agent', 2],
  ])('keeps known synthetic bindings accepted (%s)', value =>
    expect(heavyExplainBindingAllowed(value, allowed)).toBe(true),
  );
  it.each([
    '203.0.113.20',
    'Mozilla/5.0 secret user agent',
    'Bearer private-token',
    '{"password":"secret"}',
    ['synthetic-agent', 'private'],
  ])('rejects unknown or sensitive bindings (%s)', value =>
    expect(heavyExplainBindingAllowed(value, allowed)).toBe(false),
  );
});

const metadataSql =
  'SELECT liekan_analysis_versions($1::uuid,$2::text,$3::text,$4::text) AS versions';
const metadataBindings = [
  ownedSite,
  ANALYSIS_ROLLUP_VERSION,
  TRAFFIC_POLICY_VERSION,
  CRAWLER_POPULATION_VERSION,
];
const versions = {
  engine: ANALYSIS_ROLLUP_VERSION,
  website: [ownedSite, 'benchmark.invalid'],
  repair: [null, '4'],
};

describe('same-snapshot metadata evidence registration', () => {
  it('accepts exactly the complete JSON from a successful owned metadata read', () => {
    const strings = new Set(allowed);
    const json = JSON.stringify(versions);
    expect(heavyExplainBindingAllowed(json, strings)).toBe(false);
    expect(
      rememberHeavyExplainVersions(
        metadataSql,
        metadataBindings,
        [{ versions }],
        new Set([ownedSite]),
        strings,
      ),
    ).toBe(true);
    expect(heavyExplainBindingAllowed(json, strings)).toBe(true);
    expect(heavyExplainBindingAllowed('benchmark.invalid', strings)).toBe(false);
    expect(heavyExplainBindingAllowed(JSON.stringify({ repair: [null, '4'] }), strings)).toBe(
      false,
    );
  });
  it.each([
    ['SELECT other_metadata() AS versions', metadataBindings, [{ versions }]],
    [metadataSql, ['unowned', ...metadataBindings.slice(1)], [{ versions }]],
    [
      metadataSql,
      [ownedSite, 'analysis-rollups-future', ...metadataBindings.slice(2)],
      [{ versions }],
    ],
    [
      metadataSql,
      [ownedSite, metadataBindings[1], 'traffic-future', metadataBindings[3]],
      [{ versions }],
    ],
    [metadataSql, [...metadataBindings.slice(0, 3), 'population-future'], [{ versions }]],
    [metadataSql, [...metadataBindings, 'extra'], [{ versions }]],
    [metadataSql, metadataBindings.slice(0, 3), [{ versions }]],
    [metadataSql, metadataBindings, []],
    [metadataSql, metadataBindings, [{ versions }, { versions }]],
    [metadataSql, metadataBindings, [{ versions: null }]],
    [metadataSql, metadataBindings, [{ versions: {} }]],
    [metadataSql, metadataBindings, [{ versions: [] }]],
    [metadataSql, metadataBindings, [{ unrelated: versions }]],
  ])('rejects an unrecognized metadata read or result (%s)', (sql, bindings, rows) => {
    const strings = new Set(allowed);
    expect(
      rememberHeavyExplainVersions(
        sql as string,
        bindings as unknown[],
        rows,
        new Set([ownedSite]),
        strings,
      ),
    ).toBe(false);
    expect(strings).toEqual(allowed);
    expect(heavyExplainBindingAllowed(JSON.stringify(versions), strings)).toBe(false);
  });
  it.each(['log', 'visit', 'all', 'UTC'])('permits the fixed rollup enum %s', value =>
    expect(heavyExplainBindingAllowed(value, allowed)).toBe(true),
  );
});

it('rejects an empty structured trend result in cache acceptance evidence', () => {
  const functions = [{ name: 'trend', result: { rows: [], population: { identity: { status: 'unavailable' } } }, statements: [{ planId: 'plan' }] }];
  const plans = [{ id: 'plan', plan: [{}] }];
  expect(heavyExplainCoveragePassed(['trend'], functions as any, plans as any)).toBe(false);
  functions[0].result.rows.push({ pageviews: 1 } as never);
  expect(heavyExplainCoveragePassed(['trend'], functions as any, plans as any)).toBe(true);
});
