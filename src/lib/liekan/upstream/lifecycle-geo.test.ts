// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ lock: vi.fn(), ai: vi.fn(), history: vi.fn(), invalidate: vi.fn() }));
vi.mock('./server', () => ({ lockWritableWebsite: h.lock }));
vi.mock('./ai-lifecycle', () => ({ clearAiWebsiteInTransaction: h.ai }));
vi.mock('./history-repair-lifecycle', () => ({
  clearHistoryRepair: h.history,
  invalidateHistoryRepair: h.invalidate,
}));
import { resetLiekanStatistics, stopWebsiteSources } from './lifecycle';
const site = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.clearAllMocks();
  h.lock.mockResolvedValue(undefined);
});
function transaction() {
  const calls: Array<[string, ...unknown[]]> = [];
  const run = async (sql: string, ...params: unknown[]) => {
    calls.push([sql, ...params]);
    if (sql.includes("to_regclass('liekan_robots_state')")) return [{ present: true }];
    if (sql.startsWith('SELECT website_id FROM liekan_robots_state')) return [{ website_id: site }];
    return 1;
  };
  return { calls, $executeRawUnsafe: vi.fn(run), $queryRawUnsafe: vi.fn(run) };
}
it('fences old GEO publication before resetting input and frees current-day capacity', async () => {
  const tx = transaction();
  await resetLiekanStatistics(tx, site);
  const head = tx.calls.findIndex(([sql]) => sql.startsWith('DELETE FROM liekan_geo_weight_head'));
  const snapshot = tx.calls.findIndex(([sql]) =>
    sql.startsWith('DELETE FROM liekan_geo_weight_snapshot'),
  );
  const logs = tx.calls.findIndex(([sql]) => sql.startsWith('DELETE FROM liekan_log WHERE'));
  expect(head).toBeGreaterThan(0);
  expect(snapshot).toBeGreaterThan(head);
  expect(logs).toBeGreaterThan(snapshot);
  for (const [sql, id] of tx.calls.filter(([sql]) => sql.includes('liekan_geo_weight_'))) {
    expect(sql).toContain('WHERE website_id=$1::uuid');
    expect(id).toBe(site);
  }
  expect(tx.calls.at(-1)?.[0]).toContain('DELETE FROM liekan_geo_weight_evidence_revision');
});
it('deletion frees snapshots while a source pause retains published result history', async () => {
  const paused = transaction();
  await stopWebsiteSources(paused, site);
  expect(paused.calls.some(([sql]) => sql.includes('liekan_geo_weight_'))).toBe(false);
  const deleted = transaction();
  await stopWebsiteSources(deleted, site, true);
  expect(deleted.calls.filter(([sql]) => sql.includes('liekan_geo_weight_'))).toHaveLength(3);
});
it('does not change GEO state when the website write boundary rejects the operation', async () => {
  const tx = transaction();
  h.lock.mockRejectedValue(new Error('denied'));
  await expect(resetLiekanStatistics(tx, site)).rejects.toThrow('denied');
  expect(tx.calls.some(([sql]) => sql.includes('liekan_geo_weight_'))).toBe(false);
});
it.each([false, true])(
  'invalidates robots authority on website lifecycle changes (deleted=%s)',
  async deleted => {
    const tx = transaction();
    await stopWebsiteSources(tx, site, deleted);
    const lock = tx.calls.findIndex(
      ([sql]) => sql.includes('FROM liekan_robots_state') && sql.includes('FOR UPDATE NOWAIT'),
    );
    const binding = tx.calls.findIndex(([sql]) => sql.startsWith('UPDATE liekan_robots_state'));
    const source = tx.calls.findIndex(([sql]) => sql.startsWith('UPDATE liekan_crawler_state'));
    expect(lock).toBeGreaterThan(0);
    expect(binding).toBeGreaterThan(lock);
    expect(source).toBeGreaterThan(binding);
    expect(tx.calls[binding][0]).toContain('agent_enabled=false,agent_context=NULL');
    expect(tx.calls[binding][0]).toContain('monitor=false');
    expect(tx.calls[binding][0]).toContain('check_lease=NULL,checking_until=NULL');
    const deployments = tx.calls.filter(([sql]) =>
      sql.startsWith('UPDATE liekan_robots_deployment'),
    );
    expect(deployments).toHaveLength(3);
    expect(deployments[0][0]).toContain("state='cancelled'");
    expect(deployments[1][0]).toContain("state='unknown'");
    expect(deployments[2][0]).toContain("state='verification_failed'");
    for (const [sql, id] of [tx.calls[binding], ...deployments]) {
      expect(sql).toContain('WHERE website_id=$1::uuid');
      expect(id).toBe(site);
    }
  },
);
it('fails fast before source changes when the robots helper state lock is contended', async () => {
  const tx = transaction();
  const query = tx.$queryRawUnsafe.getMockImplementation()!;
  tx.$queryRawUnsafe.mockImplementation(async (sql, ...params) => {
    if (sql.includes('FROM liekan_robots_state')) throw { meta: { code: '55P03' } };
    return query(sql, ...params);
  });
  await expect(stopWebsiteSources(tx, site)).rejects.toMatchObject({ status: 409 });
  expect(tx.calls.some(([sql]) => sql.startsWith('UPDATE liekan_crawler_state'))).toBe(false);
});
