// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  portableReplay,
  demoReplayDocument,
  exportOfficialDemo,
} from '../../../scripts/liekan-export-demo.mjs';
import { checkOfficialDemo } from '../../../scripts/liekan-check-demo.mjs';
import { validateDemoRow, materializeDemoRow } from '../../../scripts/liekan-demo-format.mjs';
import {
  DEFAULT_DEMO_DOMAIN,
  DEFAULT_DEMO_ID,
  DEFAULT_DEMO_NAME,
  readDemoManifest,
  seedOfficialDemo,
} from '../../../scripts/liekan-demo.mjs';

describe('default official demo bundle', () => {
  it('contains every feature, thirty recent days and anonymous portable references', async () => {
    const result = await checkOfficialDemo();
    expect(result.recentDays).toBeGreaterThanOrEqual(30);
    expect(result.counts.event).toBeGreaterThan(600000);
    expect(result.counts.replay).toBeGreaterThan(100);
    expect(result.counts.revenue).toBeGreaterThan(300);
    expect(result.performance).toBeGreaterThan(1000);
  }, 30000);

  it('rejects private fields, broken references and future dates', async () => {
    const manifest = await readDemoManifest();
    expect(() =>
      validateDemoRow('event', { session_id: manifest.counts.session }, manifest),
    ).toThrow('reference');
    expect(() => validateDemoRow('event', { created_at: 1 }, manifest)).toThrow('date');
    expect(() => validateDemoRow('log', { ip_hash: 'private' }, manifest)).toThrow('field');
    expect(() => validateDemoRow('coverage', { state: 'observed' }, manifest)).toThrow('coverage');
  });

  it('shifts a portable replay and regenerates installation-local identifiers', () => {
    const anchor = Date.parse('2026-10-24T05:00:00Z');
    const row = materializeDemoRow(
      'replay',
      {
        replay_id: 0,
        session_id: 0,
        visit_id: 0,
        started_at: -2000,
        ended_at: -1000,
        created_at: -1000,
        events: [{ type: 5, timestamp: -1000, data: { tag: '示例' } }],
      },
      0,
      anchor,
      'temporary-test-key',
      'admin',
    );
    expect(row.started_at).toBe('2026-10-24T04:59:58.000Z');
    expect(
      JSON.parse(gunzipSync(Buffer.from(row.events.slice(2), 'hex')).toString())[0].timestamp,
    ).toBe(anchor - 1000);
  });

  it('rejects credentials embedded in replay URLs', () => {
    const events = [
      {
        type: 4,
        timestamp: 0,
        data: {
          href: 'https://private-user:private-password@www.liekan.com/',
          width: 1440,
          height: 900,
        },
      },
      { type: 2, timestamp: 0, data: { node: demoReplayDocument } },
      { type: 3, timestamp: 0, data: {} },
      { type: 3, timestamp: 0, data: {} },
      { type: 3, timestamp: 0, data: {} },
      { type: 5, timestamp: 0, data: {} },
    ];
    expect(() => portableReplay(gzipSync(Buffer.from(JSON.stringify(events))), 0)).toThrow(
      'metadata',
    );
  });

  it('moves traffic dates to the installation window and keeps generated identities stable', () => {
    const row = { session_id: 23, browser: 'chrome', created_at: -60000 };
    const anchor = Date.parse('2026-10-10T03:00:00Z');
    const first = materializeDemoRow('session', row, 0, anchor, 'temporary-test-key', 'admin');
    const later = materializeDemoRow(
      'session',
      row,
      0,
      anchor + 86400000,
      'temporary-test-key',
      'admin',
    );
    expect(first.created_at).toBe('2026-10-10T02:59:00.000Z');
    expect(later.session_id).toBe(first.session_id);
    expect(later.created_at).toBe('2026-10-11T02:59:00.000Z');
  });

  it('rejects unsafe export schemas before querying', async () => {
    const query = vi.fn();
    await expect(
      exportOfficialDemo({ query }, { schema: 'public;drop table website' }),
    ).rejects.toThrow('schema');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects unsafe schema names before executing any SQL', async () => {
    const query = vi.fn();
    await expect(
      seedOfficialDemo(
        { query },
        { secret: 'temporary-test-key', schema: 'public; DROP TABLE website' },
      ),
    ).rejects.toThrow('schema');
    expect(query).not.toHaveBeenCalled();
  });

  it('preserves an incompatible custom catalog without acquiring its publication lock', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('AS previously_created')
        ? [{ previously_created: false }]
        : sql.includes('AS existing_installation')
          ? [{ existing_installation: false }]
        : sql.includes('user_id AS id')
          ? [{ id: 'd56a31e6-2ea3-4d79-aeec-536c634706de' }]
          : sql.includes('SELECT version FROM liekan_crawler_registry_current')
            ? [{ version: 'd56a31e6-2ea3-4d79-aeec-536c634706de' }]
            : sql.includes('SELECT version,payload')
              ? [
                  {
                    version: 'd56a31e6-2ea3-4d79-aeec-536c634706de',
                    payload: { identities: [], rangeSources: [] },
                  },
                ]
              : [],
    }));
    await expect(
      seedOfficialDemo({ query }, { secret: 'temporary-test-key', automatic: true }),
    ).resolves.toMatchObject({ status: 'incompatible-catalog', inserted: false });
    expect(
      query.mock.calls.some(([sql]) => sql.includes('liekan-crawler-registry-initialize')),
    ).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
  });

  it('refuses to mark a real website as a demo and rolls back', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('FOR UPDATE OF w')
        ? [
            {
              name: DEFAULT_DEMO_NAME,
              domain: DEFAULT_DEMO_DOMAIN,
              is_demo: false,
              deleted_at: null,
            },
          ]
        : [],
    }));
    await expect(seedOfficialDemo({ query }, { secret: 'temporary-test-key' })).rejects.toThrow(
      '其他网站',
    );
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => /INSERT|DELETE|UPDATE "user"/.test(sql))).toBe(false);
  });

  it('preserves an existing populated example on repeated initialization', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('FOR UPDATE OF w')
        ? [
            {
              name: DEFAULT_DEMO_NAME,
              domain: DEFAULT_DEMO_DOMAIN,
              is_demo: true,
              deleted_at: null,
            },
          ]
        : sql.includes('AS occupied')
          ? [{ occupied: true }]
          : [],
    }));
    await expect(seedOfficialDemo({ query }, { secret: 'temporary-test-key' })).resolves.toEqual({
      websiteId: DEFAULT_DEMO_ID,
      status: 'existing',
      inserted: false,
    });
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(query.mock.calls.some(([sql]) => /INSERT|DELETE|UPDATE "user"/.test(sql))).toBe(false);
  });

  it('skips automatic demo creation when an existing installation has other websites', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('AS previously_created')
        ? [{ previously_created: false }]
        : sql.includes('AS existing_installation')
          ? [{ existing_installation: true }]
          : [],
    }));
    await expect(
      seedOfficialDemo({ query }, { secret: 'temporary-test-key', automatic: true }),
    ).resolves.toMatchObject({ status: 'existing-installation', inserted: false });
    expect(query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
  });

  it('keeps a deleted example deleted', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('FOR UPDATE OF w')
        ? [
            {
              name: DEFAULT_DEMO_NAME,
              domain: DEFAULT_DEMO_DOMAIN,
              is_demo: true,
              deleted_at: new Date(),
            },
          ]
        : [],
    }));
    await expect(seedOfficialDemo({ query }, { secret: 'temporary-test-key' })).resolves.toEqual({
      websiteId: DEFAULT_DEMO_ID,
      status: 'deleted',
      inserted: false,
    });
    expect(query.mock.calls.some(([sql]) => /INSERT|DELETE|UPDATE "user"/.test(sql))).toBe(false);
  });

  it('preserves a hard-deleted example using its durable analytics revision', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('AS previously_created') ? [{ previously_created: true }] : [],
    }));
    await expect(seedOfficialDemo({ query }, { secret: 'temporary-test-key' })).resolves.toEqual({
      websiteId: DEFAULT_DEMO_ID,
      status: 'deleted',
      inserted: false,
    });
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(query.mock.calls.some(([sql]) => /INSERT|DELETE|UPDATE "user"/.test(sql))).toBe(false);
  });
});
