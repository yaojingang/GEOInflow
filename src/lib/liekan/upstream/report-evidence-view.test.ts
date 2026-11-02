import { expect, it, vi } from 'vitest';
import { reportQuery } from '../contracts/query';
import type { LiekanReport } from '../contracts/report';
import { attachReportEvidenceView } from './report-evidence-view';
import { reportEvidenceViewPayload } from '../contracts/report-evidence-view';

vi.mock('./server', () => ({ query: vi.fn(async () => []) }));

it('binds export proof to the actual read range of a current-day cached report', async () => {
  const startAt = Date.parse('2026-10-01T00:00:00Z');
  const endAt = Date.parse('2026-10-23T06:00:00Z');
  const selectedEnd = Date.parse('2026-10-24T00:00:00Z');
  const report: LiekanReport = {
    contractVersion: 2,
    website: { id: 'site', name: 'Fixture', domain: 'example.test' },
    range: { startAt, endAt, timezone: 'UTC' },
    states: { human: 'empty', logs: 'empty', catalog: 'empty', goals: 'empty' },
    cards: [],
    charts: {},
    tables: {},
    insights: [],
    meta: { demo: false, canManage: true, latestImportAt: null, ruleCount: 0 },
  };
  const input = reportQuery.parse({
    resource: 'ai/pages',
    startAt,
    endAt: selectedEnd,
    timezone: 'UTC',
    crawlerMetricsVersion: 1,
    botProductForm: 'workbench',
  });
  const result = await attachReportEvidenceView(report, input);
  expect(result.meta.crawlerEvidenceView.query).toMatchObject({
    startAt,
    endAt,
    timezone: 'UTC',
    resource: 'ai/pages',
    botProductForm: 'workbench',
  });
  expect(input.endAt).toBe(selectedEnd);
  expect(result.meta.crawlerEvidenceView.snapshot).toMatch(/^[a-f0-9]{64}$/);
});

it.each(['ai/bots', 'ai/pages', 'logs'] as const)(
  'preserves %s evidence identity through stored object-key reordering and retains displayed row order',
  async resource => {
    const table = { 'ai/bots': 'botBody', 'ai/pages': 'apBody', logs: 'logBody' }[resource];
    const startAt = Date.parse('2026-10-23T00:00Z');
    const endAt = startAt + 3600000;
    const report: LiekanReport = {
      contractVersion: 2,
      website: { id: 'site', name: 'Synthetic evidence fixture', domain: 'example.test' },
      range: { startAt, endAt, timezone: 'UTC' },
      states: { human: 'empty', logs: 'available', catalog: 'empty', goals: 'empty' },
      cards: [],
      charts: {},
      insights: [],
      tables: {
        [table]: [
          { path: '/first', name: 'GPTBot', requests: 2, freshness: '0 天' },
          { path: '/second', name: 'ClaudeBot', requests: 1, freshness: '1 天' },
        ],
      },
      meta: {
        demo: false,
        canManage: true,
        latestImportAt: null,
        ruleCount: 0,
        tablePages: { [table]: { page: 1, pageSize: 20, total: 2 } },
      },
    };
    const input = reportQuery.parse({
      resource,
      startAt,
      endAt,
      timezone: 'UTC',
      crawlerMetricsVersion: 1,
    });
    await attachReportEvidenceView(report, input);
    const originalSnapshot = report.meta.crawlerEvidenceView.snapshot;
    const reorderKeys = (value: any): any =>
      Array.isArray(value)
        ? value.map(reorderKeys)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, item]) => [key, reorderKeys(item)]),
            )
          : value;
    const stored: LiekanReport = reorderKeys(JSON.parse(JSON.stringify(report)));
    const display = { filter: '全部', sort: { label: '', direction: 1 }, search: '' };
    const originalPayload = reportEvidenceViewPayload(report, display);
    expect(reportEvidenceViewPayload(stored, display)).toBe(originalPayload);
    await attachReportEvidenceView(stored, input);
    expect(stored.meta.crawlerEvidenceView.snapshot).toBe(originalSnapshot);

    stored.tables[table].reverse();
    expect(reportEvidenceViewPayload(stored, display)).not.toBe(originalPayload);
    stored.tables[table].reverse();
    stored.tables[table][0].requests = 3;
    expect(reportEvidenceViewPayload(stored, display)).not.toBe(originalPayload);
  },
);
