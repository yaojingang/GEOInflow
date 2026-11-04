// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ getBearerToken: () => null }));
vi.mock('../upstream/report-evidence-view', () => ({ attachReportEvidenceView: vi.fn() }));
vi.mock('../upstream/warehouse-report-page-comparison', () => ({
  warehouseReportPageComparison: vi.fn(),
}));
vi.mock('../upstream/feature-exports', () => ({
  csvFieldLabel: (value: unknown) => value,
  csvDisplayValue: (value: unknown) => value,
}));
vi.mock('./evidence-snapshot', () => ({ evidenceSnapshot: (work: any) => work() }));
const h = vi.hoisted(() => ({
  failFence: false,
  actor: { id: 'actor', role: 'admin' },
  policy: 'a'.repeat(64),
  snapshot: 'b'.repeat(64),
}));
vi.mock('../warehouse/authority-routing', () => ({ warehouseEnabled: () => true }));
vi.mock('../upstream/crawler-registry-context', () => ({
  withPublishedRegistry: (work: any) => work(),
}));
vi.mock('./published', () => ({
  getPublishedCatalog: () => ({ version: '00000000-0000-4000-8000-000000000001' }),
}));
vi.mock('../upstream/warehouse-report-snapshot', () => ({
  warehouseReportMetadata: async () => ({}),
  warehouseControlFingerprint: () => 'stable',
  withinWarehouseReport: async (work: any) => {
    const result = await work();
    if (h.failFence) throw new Error('final-policy-fence');
    return result;
  },
}));
vi.mock('../warehouse/reporting-context', () => ({ readReportingMetadata: async () => ({}) }));
vi.mock('../warehouse/reader-runtime', () => ({ warehouseReader: () => ({ db: {} }) }));
vi.mock('../upstream/crawler-access', () => ({
  authenticateCrawler: async () => h.actor,
  authorizeCrawler: async () => ({}),
  crawlerTransaction: (work: any) => work({}),
}));
vi.mock('./evidence-read', () => ({
  parseEvidenceQuery: (v: any) => v,
  readCrawlerEvidence: vi.fn(),
  readReconciliation: vi.fn(),
  queryEvidence: async () => ({
    meta: { policySnapshot: h.policy, snapshot: h.snapshot, readAt: '2026-11-03T00:00:00Z' },
    rows: [{ id: 'synthetic', time: new Date('2026-11-03T00:00:00Z'), requests: 1 }],
  }),
}));
vi.mock('./report-evidence', () => ({ readReportEvidence: vi.fn(), reportEvidenceCsv: vi.fn() }));
vi.mock('./outcomes-read', () => ({ readOutcomes: vi.fn() }));
vi.mock('./observation-read', () => ({
  parseObservationQuery: (v: any) => v,
  readObservations: vi.fn(),
}));
vi.mock('./performance-read', () => ({
  parsePerformanceQuery: (v: any) => v,
  readPerformance: vi.fn(),
}));
vi.mock('../report', () => ({ buildReport: vi.fn() }));

import { exportEvidence } from './evidence-export';

afterEach(() => {
  vi.unstubAllEnvs();
  h.failFence = false;
});
it('cancels and removes a materialized CSV when the final publication control fence fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'liekan-evidence-fence-'));
  vi.stubEnv('LIEKAN_EXPORT_DIRECTORY', directory);
  vi.stubEnv('LIEKAN_EXPORT_MIN_FREE_BYTES', '0');
  h.failFence = true;
  try {
    await expect(
      exportEvidence(
        h.actor,
        'site',
        { kind: 'evidence', query: {}, locale: 'en-US', policySnapshot: h.policy },
        new Request('http://localhost/evidence'),
        ['evidence'],
      ),
    ).rejects.toThrow('final-policy-fence');
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('removes the temporary CSV after a successful streamed download', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'liekan-evidence-download-'));
  vi.stubEnv('LIEKAN_EXPORT_DIRECTORY', directory);
  vi.stubEnv('LIEKAN_EXPORT_MIN_FREE_BYTES', '0');
  try {
    const result = await exportEvidence(
      h.actor,
      'site',
      { kind: 'evidence', query: {}, locale: 'en-US', policySnapshot: h.policy },
      new Request('http://localhost/evidence'),
      ['evidence'],
    );
    expect(await result.text()).toContain('"2026-11-03T00:00:00.000Z"');
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
