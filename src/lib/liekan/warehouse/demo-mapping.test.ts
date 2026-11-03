import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { DemoFactMapping, warehouseDemoFamily } from './demo-mapping';
import { rowDigest } from './codec';
import { seedWarehouseDemo } from './demo';
import type { ControlDatabase } from './control-db';
import type { ClickHouseClient } from '@clickhouse/client';

vi.mock('./installation-identity', () => ({ verifyBoundWarehouse: vi.fn() }));

describe('complete signed demonstration mapping', () => {
  it('maps every fixture kind without dropping quality, replay, revenue or crawler proof', async () => {
    const fixture = await import(pathToFileURL(resolve('scripts/liekan-demo.mjs')).href);
    const format = await import(pathToFileURL(resolve('scripts/liekan-demo-format.mjs')).href);
    const manifest = await fixture.readDemoManifest();
    const samples = new Map<string, Record<string, any>>();
    const replayRows: Record<string, any>[] = [],
      bookmarks: Record<string, any>[] = [];
    for await (const [kind, row] of fixture.readDemoRecords()) {
      if (!samples.has(kind)) samples.set(kind, row);
      if (kind === 'replay') replayRows.push(row);
      if (kind === 'saved-replay') bookmarks.push(row);
    }
    const anchor = Date.parse('2026-11-03T00:00:00Z');
    const materialize = (kind: string, row: any) => {
      format.validateDemoRow(kind, row, manifest);
      const values = format.materializeDemoRow(
        kind,
        row,
        0,
        anchor,
        'unit-demo-secret',
        fixture.DEFAULT_DEMO_ID,
      );
      if (values.catalog_version) values.catalog_version = fixture.DEFAULT_DEMO_ID;
      return values;
    };
    const mapping = new DemoFactMapping(
      manifest.counts,
      fixture.DEFAULT_DEMO_ID,
      fixture.DEFAULT_DEMO_DOMAIN,
      anchor,
    );
    const parents = new Set(
      [...samples.values()].flatMap(row =>
        row.event_id === undefined && row.website_event_id === undefined
          ? []
          : [row.event_id ?? row.website_event_id],
      ),
    );
    for await (const [kind, row] of fixture.readDemoRecords()) {
      if (
        (kind === 'event' && parents.has(row.event_id)) ||
        (kind === 'log' && row.id === samples.get('evidence').log_id)
      )
        mapping.facts(format.demoSpecs[kind].table, row, materialize(kind, row));
      if (kind === 'evidence') break;
    }
    const results = new Map<string, ReturnType<DemoFactMapping['facts']>>();
    for (const kind of format.demoKinds) {
      const family = warehouseDemoFamily(format.demoSpecs[kind].table);
      const row = samples.get(kind);
      if (family) results.set(kind, mapping.facts(family, row, materialize(kind, row)));
    }
    expect(results.size).toBe(13);
    expect(results.get('quality')[0].row.classification).toBe('browser');
    expect(results.get('quality')[0].sessionId).toBeTruthy();
    expect(results.get('geography')[0].recordTime).toBe(results.get('quality')[0].recordTime);
    expect(results.get('evidence')[0].row.catalog_version).toBe(fixture.DEFAULT_DEMO_ID);
    expect(results.get('evidence')[0].recordTime).toBe(results.get('log')[0].recordTime);
    const [data, proof] = results.get('session-data');
    expect(proof.propertyProof).toEqual({
      sourceHash: proof.hash,
      dataHash: rowDigest('session_data', data.row),
    });
    expect(results.get('revenue')[0].row.revenue).toBe(samples.get('revenue').revenue);
    for (const row of replayRows) mapping.facts('session_replay', row, materialize('replay', row));
    expect(bookmarks).toHaveLength(manifest.counts['saved-replay']);
    for (const row of bookmarks) {
      const saved = materialize('saved-replay', row);
      const owner = mapping.replayBookmarkOwner(saved);
      const parents = new Set(
        replayRows
          .filter(replay => replay.visit_id === row.visit_id)
          .map(replay => replay.session_id),
      );
      expect(parents.size).toBe(1);
      expect(owner.session_id).toBe(format.demoUuid('session', [...parents][0]));
      expect(owner.saved_replay_id).toBe(saved.saved_replay_id);
    }
    const replay = JSON.parse(
      gunzipSync(Buffer.from(results.get('replay')[0].row.events as string, 'hex')).toString(),
    );
    expect(replay[0].timestamp).toBe(anchor + samples.get('replay').events[0].timestamp);
    expect(() => warehouseDemoFamily('liekan_report_fragment')).toThrow('unregistered-table');
    expect(() => warehouseDemoFamily('unregistered')).toThrow('unregistered-table');
  }, 60000);

  it('keeps replay ownership stable across chunks and rejects absent or ambiguous parents', () => {
    const site = 'b880cb21-e65a-4fdf-9c0e-3da5aed4e0fa',
      session = '11111111-1111-4111-8111-111111111111',
      other = '22222222-2222-4222-8222-222222222222',
      visit = '33333333-3333-4333-8333-333333333333',
      bookmark = '44444444-4444-4444-8444-444444444444';
    const mapping = new DemoFactMapping({ event: 0, log: 0 }, site, 'www.liekan.com', Date.now());
    const saved = { saved_replay_id: bookmark, website_id: site, visit_id: visit };
    expect(() => mapping.replayBookmarkOwner(saved)).toThrow('replay-owner-missing');
    const values = {
      replay_id: bookmark,
      website_id: site,
      session_id: session,
      visit_id: visit,
      chunk_index: 0,
      events: `\\x${gzipSync(Buffer.from('[]')).toString('hex')}`,
      event_count: 0,
      started_at: '2026-11-03T00:00:00Z',
      ended_at: '2026-11-03T00:00:00Z',
      created_at: '2026-11-03T00:00:00Z',
    };
    mapping.facts('session_replay', {}, values);
    mapping.facts('session_replay', {}, { ...values, chunk_index: 1 });
    expect(mapping.replayBookmarkOwner(saved)).toEqual({ ...saved, session_id: session });
    expect(() => mapping.replayBookmarkOwner({ ...saved, website_id: other })).toThrow(
      'bookmark-site-changed',
    );
    expect(() => mapping.facts('session_replay', {}, { ...values, session_id: other })).toThrow(
      'replay-owner-ambiguous',
    );
    expect(() => mapping.replayBookmarkOwner(saved)).toThrow('replay-owner-missing');
  });

  it.each([
    ['postgres', 'postgres', false],
    ['frozen', 'frozen', false],
    ['open-transition', 'clickhouse', true],
    ['pending-barrier', 'clickhouse', true],
  ])(
    'automatic startup skips %s authority without blocking application startup',
    async (_name, authority, pending) => {
      const statements: string[] = [];
      const query = async (sql: string) => {
        statements.push(sql);
        const rows = sql.includes('SELECT authority')
          ? [{ authority }]
          : sql.includes('FROM liekan_warehouse_transition') && pending
            ? [{ present: 1 }]
            : [];
        return { rows, rowCount: rows.length };
      };
      const db = { transaction: async (fn: any) => fn({ query }) } as ControlDatabase;
      expect(
        await seedWarehouseDemo(db, {} as ClickHouseClient, {
          secret: 'unit-demo-secret',
          automatic: true,
        }),
      ).toEqual({
        websiteId: 'b880cb21-e65a-4fdf-9c0e-3da5aed4e0fa',
        status: 'warehouse-transition',
        inserted: false,
      });
      expect(
        statements.every(sql => /^SELECT (authority|1 FROM liekan_warehouse_transition)/.test(sql)),
      ).toBe(true);
      await expect(
        seedWarehouseDemo(db, {} as ClickHouseClient, { secret: 'unit-demo-secret' }),
      ).rejects.toThrow('warehouse-demo-requires-final-clickhouse');
    },
  );

  it.each([
    [
      'customized',
      { name: '用户自定义名称', domain: 'www.liekan.com', is_demo: true, deleted_at: null },
    ],
    [
      'deleted',
      {
        name: '猎看官网（示例数据）',
        domain: 'www.liekan.com',
        is_demo: true,
        deleted_at: '2026-01-01',
      },
    ],
    [
      'existing',
      { name: '猎看官网（示例数据）', domain: 'www.liekan.com', is_demo: true, deleted_at: null },
    ],
  ])('automatic startup preserves an %s demo without writes', async (status, existing) => {
    const statements: string[] = [];
    const query = async (sql: string) => {
      statements.push(sql);
      const rows = sql.includes('SELECT authority')
        ? [{ authority: 'clickhouse' }]
        : sql.includes('SELECT w.name')
          ? [existing]
          : [];
      return { rows, rowCount: rows.length };
    };
    const db = { transaction: async (fn: any) => fn({ query }) } as ControlDatabase;
    expect(
      await seedWarehouseDemo(db, {} as ClickHouseClient, {
        secret: 'unit-demo-secret',
        automatic: true,
      }),
    ).toEqual({ websiteId: 'b880cb21-e65a-4fdf-9c0e-3da5aed4e0fa', status, inserted: false });
    expect(statements.some(sql => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
  });
});
