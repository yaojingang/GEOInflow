// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ reader: undefined as any, busy: false, timeout: false }));
vi.mock('../warehouse/reader-runtime', () => ({ warehouseReader: () => h.reader }));
vi.mock('../warehouse/reporting-context', () => ({
  readReportingMetadata: async () => ({ boundary: { epoch: '0', publication: '2' } }),
}));
vi.mock('./warehouse-report-snapshot', () => ({ warehouseControlFingerprint: () => 'control' }));
vi.mock('./warehouse-analysis-model', () => ({ analysisModelVersion: 'analysis-model-v1' }));
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
beforeEach(() => {
  vi.resetModules();
  h.busy = false;
  h.timeout = false;
  h.reader = {
    verifyIdentity: vi.fn(),
    db: {
      read: async () => [{ website_id: a }],
      transaction: async (work: any) =>
        work({
          query: async (sql: string) => ({
            rows: sql.includes('SELECT epoch')
              ? [{ epoch: '0', publication: '2' }]
              : sql.includes('AS present')
                ? [{ present: h.busy }]
                : [],
          }),
        }),
    },
    ch: {
      query: vi.fn(async ({ query }: { query: string }) => ({
        json: async () =>
          query.includes('toString(checkpoint)')
            ? [{ checkpoint: a, browser: '[]', log: '[]' }]
            : query.startsWith('SELECT browser,log')
              ? [a, b].map(build => ({ browser: JSON.stringify([[0, build, 1, 1]]), log: '[]' }))
              : [{ present: 1 }],
      })),
      command: vi.fn(async () => {
        if (h.timeout) throw new Error('mutation wait timed out');
      }),
    },
  };
});

it('retires coverage first and retains builds from every remaining selectable manifest', async () => {
  const { collectAnalysisArtifacts } = await import('./warehouse-analysis-gc');
  await collectAnalysisArtifacts(new AbortController().signal);
  const calls = h.reader.ch.command.mock.calls.map(([p]: any[]) => p);
  expect(calls).toHaveLength(2);
  expect(calls[0].query).toContain('ALTER TABLE warehouse_analysis_coverage_v1');
  expect(calls[1].query).toContain('ALTER TABLE warehouse_analysis_browser_v1');
  expect(calls[1].query_params.browserBuilds).toEqual([a, b]);
  expect(calls[1].query).toContain('epoch={epoch:UInt64}');
});

it('does not delete data after coverage retirement times out and may continue asynchronously', async () => {
  h.timeout = true;
  const { collectAnalysisArtifacts } = await import('./warehouse-analysis-gc');
  await expect(collectAnalysisArtifacts(new AbortController().signal)).rejects.toThrow('timed out');
  expect(h.reader.ch.command).toHaveBeenCalledTimes(1);
  expect(
    h.reader.ch.query.mock.calls.some(([p]: any[]) => p.query.startsWith('SELECT browser,log')),
  ).toBe(false);
});

it('leaves manifests and data untouched while a reader or builder is active', async () => {
  h.busy = true;
  const { collectAnalysisArtifacts } = await import('./warehouse-analysis-gc');
  await collectAnalysisArtifacts(new AbortController().signal);
  expect(h.reader.ch.query).not.toHaveBeenCalled();
  expect(h.reader.ch.command).not.toHaveBeenCalled();
});
