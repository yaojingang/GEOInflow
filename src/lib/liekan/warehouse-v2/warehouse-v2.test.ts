// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ClickHouseClient } from '@clickhouse/client';
import { ensureV2Schema } from './client';
import {
  buildCatalogMappings,
  buildV2LogRow,
  clearV2CatalogCache,
  computeObservationMask,
  normalizeHost,
  type PgReadClient,
  queryV2Observations,
  queryV2Reconciliation,
  readV2CatalogCached,
  readV2ControlContext,
  v2AnalyticsEventRelation,
  v2BrowserEventRelation,
  v2EffectiveLogRelation,
  v2GeographicEventRelation,
  v2NativeRelations,
  v2QualityAuditRelation,
  v2ReportingLogRelation,
  v2Tables,
  v2Views,
  v2WebsiteSummaryEventRelation,
  WarehouseV2Batcher,
  warehouseV2DDL,
  warehouseV2Enabled,
} from './index';

describe('warehouse-v2 schema', () => {
  it.each([
    { installed: 0, canInstall: 0, column: 'MATERIALIZED', addsProjection: false },
    { installed: 0, canInstall: 1, column: 'MATERIALIZED', addsProjection: true },
    { installed: 1, canInstall: 0, column: 'ALIAS', addsProjection: false },
  ])('installs the GEO history read path for $installed/$canInstall', async scenario => {
    const ddl: string[] = [];
    const ch = {
      query: async () => ({ json: async () => [scenario] }),
      command: async ({ query }: { query: string }) => ddl.push(query),
    } as unknown as ClickHouseClient;
    await ensureV2Schema(ch);
    const column = ddl.findIndex(q => q.includes('ADD COLUMN IF NOT EXISTS geo_history_row_hash'));
    expect(column).toBeGreaterThanOrEqual(0);
    expect(ddl[column]).toContain(`UInt128 ${scenario.column}`);
    const projection = ddl.findIndex(q => q.includes('ADD PROJECTION'));
    if (scenario.addsProjection) {
      expect(projection).toBeGreaterThan(column);
      expect(ddl[projection]).toContain('sumWithOverflow(geo_history_row_hash)');
    } else {
      expect(projection).toBe(-1);
    }
  });

  it('defines flat fact tables and native materialized views without fsync_after_insert', () => {
    const ddls = warehouseV2DDL();
    expect(ddls.length).toBeGreaterThanOrEqual(10);
    const joined = ddls.join('\n');
    expect(joined).toContain(`CREATE TABLE IF NOT EXISTS ${v2Tables.logs}`);
    expect(joined).toContain(`CREATE TABLE IF NOT EXISTS ${v2Tables.browserEvents}`);
    expect(joined).toContain(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${v2Views.logPathHourAgg}`);
    expect(joined).toContain(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${v2Views.observationHourAgg}`);
    expect(joined).toContain(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${v2Views.browserPathHourAgg}`);
    expect(joined).not.toContain('fsync_after_insert');
    expect(joined).not.toContain('fsync_part_directory');
    expect(joined).not.toContain('warehouse_landing');
    expect(joined).not.toContain('warehouse_publication');
  });
});

describe('warehouse-v2 ingest helpers and batcher', () => {
  it('computes 5-bit observation mask and normalizes log rows accurately', () => {
    expect(
      computeObservationMask({
        accept: { state: 'present' },
        language: { state: 'missing' },
        site: { state: 'present' },
        mode: { state: 'present' },
        dest: { state: 'present' },
      }),
    ).toBe(1 + 4 + 8 + 16);

    expect(normalizeHost('WWW.Example.COM.')).toBe('example.com');

    const row = buildV2LogRow({
      websiteId: '11111111-1111-1111-1111-111111111111',
      epoch: 1,
      id: 'log-1',
      createdAt: '2026-11-21T08:00:00.000Z',
      path: '/hello%20world',
      method: 'GET',
      status: 200,
      userAgent: 'GPTBot/1.0',
      bot: 'GPTBot',
      botType: 'ai',
      aiEligible: true,
      measurement: {
        host: 'www.liekan.com',
        hostBasis: 'request_host',
        sourceConfigVersion: 'cfg-1',
        sourceIntervalVersion: 'int-1',
        samplingTimeBasis: 'event_time',
        samplingBasis: 'observed_provider_config',
        samplingRate: 1,
      },
      edgeObservation: {
        fields: {
          EdgeResponseContentType: { state: 'present', value: 'text/html' },
        },
      },
    });

    expect(row.human_path).toBe('/hello world');
    expect(row.request_host).toBe('liekan.com');
    expect(row.is_self_check).toBe(false);
    expect(row.is_unknown_crawler).toBe(false);
    expect(row.content_type_state).toBe('present');
    expect(row.content_type_value).toBe('text/html');
    expect(row.sampling_rate).toBe(1);
  });

  it('coalesces concurrent micro-batches into a single ClickHouse insert with deduplication token', async () => {
    const insertCalls: any[] = [];
    const mockCh = {
      insert: vi.fn(async (arg: any) => {
        insertCalls.push(arg);
      }),
    } as unknown as ClickHouseClient;

    const batcher = new WarehouseV2Batcher<{ id: string }>(mockCh, v2Tables.logs, {
      flushMs: 20,
      maxRows: 100,
    });

    await Promise.all([
      batcher.enqueue([{ id: 'a1' }, { id: 'a2' }], 'batch-1'),
      batcher.enqueue([{ id: 'b1' }, { id: 'b2' }], 'batch-2'),
      batcher.enqueue([{ id: 'c1' }, { id: 'c2' }], 'batch-3'),
    ]);
    await batcher.close();

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].values).toHaveLength(6);
    expect(insertCalls[0].clickhouse_settings.insert_deduplication_token).toMatch(/^[0-9a-f]{32}$/);
    expect(batcher.stats.flushes).toBe(1);
    expect(batcher.stats.rowsWritten).toBe(6);
    expect(batcher.stats.batchesCoalesced).toBe(3);
  });
});

describe('warehouse-v2 stateless diagnostics', () => {
  it('reads control context in 1 read-only PG query with zero row locks', async () => {
    const queries: string[] = [];
    const mockPg = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return {
          rows: [
            {
              website_id: '11111111-1111-1111-1111-111111111111',
              domain: 'www.example.com',
              epoch: '1',
              policy_mode: 'standard',
              policy_revision: '2',
              allowed_hostnames: ['example.com'],
              catalog_version: '2026-11-21:2',
              sources: [{ id: '22222222-2222-2222-2222-222222222222', kind: 'cloudflare', domain: 'example.com', state: 'active' }],
              authorized: true,
            },
          ],
        };
      }),
    };

    const ctx = await readV2ControlContext(
      mockPg as unknown as PgReadClient,
      '11111111-1111-1111-1111-111111111111',
      '33333333-3333-3333-3333-333333333333',
    );
    expect(ctx?.domain).toBe('www.example.com');
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain('FOR SHARE');
    expect(queries[0]).not.toContain('FOR KEY SHARE');
    expect(queries[0]).not.toContain('FOR UPDATE');
    expect(queries[0]).not.toContain('liekan_warehouse_reference');
  });

  it('caches catalog mappings across repeated reconciliation reads for the same catalog version', async () => {
    clearV2CatalogCache();
    const mockPg = {
      query: vi.fn(async () => ({
        rows: [
          { path: '/a', updated_at: new Date('2026-11-21T00:00:00Z') },
          { path: '/b%20c', updated_at: new Date('2026-11-21T00:00:00Z') },
        ],
      })),
    };

    const first = await readV2CatalogCached(
      mockPg as unknown as PgReadClient,
      '11111111-1111-1111-1111-111111111111',
      'v1',
    );
    const second = await readV2CatalogCached(
      mockPg as unknown as PgReadClient,
      '11111111-1111-1111-1111-111111111111',
      'v1',
    );
    expect(mockPg.query).toHaveBeenCalledTimes(1);
    expect(second.hash).toBe(first.hash);
    expect(buildCatalogMappings(['/a', '/b%20c'])[1].humanPath).toBe('/b c');
  });

  it('computes exact observation totals, coverage, and reconciliation alignment from ClickHouse results', async () => {
    const mockCh = {
      query: vi.fn(async ({ query }: { query: string }) => ({
        json: async () => {
          if (query.includes(v2Tables.observationHourAgg)) {
            return [
              {
                is_total: 1,
                browser: '',
                collection_source: '',
                classification: '',
                obs_version: '',
                obs_features: '',
                out_pv: '181300',
                out_uv: '96000',
                out_visits: '120000',
                observed: '181300',
                not_collected: '0',
                current_version: '181300',
                flagged_pv: '0',
                flagged_uv: '0',
                id_pv: '181300',
                id_uv: '96000',
                id_versions: ['v1'],
                f_accept: '181300',
                f_language: '181300',
                f_site: '181300',
                f_mode: '181300',
                f_dest: '181300',
                out_first_event_at: '2026-11-15 00:00:00.000000',
                out_last_event_at: '2026-11-21 23:59:59.000000',
                out_last_received_at: '2026-11-21 23:59:59.500000',
              },
              {
                is_total: 0,
                browser: 'chrome',
                collection_source: 'browser',
                classification: 'human',
                obs_version: 'obs-v1',
                obs_features: '{"accept":{"state":"present"}}',
                out_pv: '181300',
                out_uv: '96000',
                out_visits: '120000',
                observed: '181300',
                not_collected: '0',
                current_version: '181300',
                flagged_pv: '0',
                flagged_uv: '0',
                id_pv: '181300',
                id_uv: '96000',
                id_versions: ['v1'],
                f_accept: '181300',
                f_language: '181300',
                f_site: '181300',
                f_mode: '181300',
                f_dest: '181300',
                out_first_event_at: '2026-11-15 00:00:00.000000',
                out_last_event_at: '2026-11-21 23:59:59.000000',
                out_last_received_at: '2026-11-21 23:59:59.500000',
              },
            ];
          }
          if (query.includes(v2Tables.logPathHourAgg)) {
            return [
              {
                path: '/p1',
                out_requests: '100',
                out_get2xx: '95',
                out_crawler: '20',
                out_candidate: '75',
                out_ambiguous: '0',
                out_content_type_samples: '100',
                out_confirmed_html: '95',
                out_host_samples: '100',
                out_config_samples: '100',
                out_unsampled_requests: '100',
                out_config_versions: '1',
                out_last_at: '2026-11-21 23:59:59.000000',
              },
            ];
          }
          return [
            { is_total: 1, url_path: '', out_pv: '50', out_uv: '40', out_visits: '45', out_unknown_host_pv: '0', out_last_at: '2026-11-21 23:59:59.000000' },
            { is_total: 0, url_path: '/p1', out_pv: '50', out_uv: '40', out_visits: '45', out_unknown_host_pv: '0', out_last_at: '2026-11-21 23:59:59.000000' },
          ];
        },
      })),
    } as unknown as ClickHouseClient;

    const control = {
      websiteId: '11111111-1111-1111-1111-111111111111',
      domain: 'example.com',
      epoch: '1',
      policyMode: 'standard',
      policyRevision: '1',
      allowedHostnames: ['example.com'],
      catalogVersion: 'v1',
      sources: [],
      browserConnected: true,
    };

    const obs = await queryV2Observations(mockCh, control, {
      startAt: Date.UTC(2026, 10, 15, 0, 0, 0),
      endAt: Date.UTC(2026, 10, 22, 0, 0, 0),
      subset: 'raw',
      observationVersion: 'obs-v1',
    });
    expect(obs.totals.pv).toBe(181300);
    expect(obs.totals.uv).toBe(96000);
    expect(obs.coverage.accept.value).toBe(1);
    expect(obs.rows).toHaveLength(1);

    const rec = await queryV2Reconciliation(
      mockCh,
      control,
      { key: 'k', paths: ['/p1'], mappings: buildCatalogMappings(['/p1']), hash: 'h' },
      {
        startAt: Date.UTC(2026, 10, 21, 0, 0, 0),
        endAt: Date.UTC(2026, 10, 22, 0, 0, 0),
        hostname: 'example.com',
      },
    );
    expect(rec.rawRequests).toBe(100);
    expect(rec.browserTotals).toEqual({ pv: 50, uv: 40, visits: 45 });
    expect(rec.rows[0].difference).toBe(25);
    expect(rec.rows[0].reason).toBeNull();
  });
});

describe('warehouse-v2 single-table SQL relations and feature toggle', () => {
  it('generates clean single-table ClickHouse SQL with zero warehouse_publication or argMax bloat', () => {
    const relations = [
      v2EffectiveLogRelation(),
      v2ReportingLogRelation({}, ['id', 'path', 'bot', 'reporting_crawler_id']),
      v2BrowserEventRelation('qualified'),
      v2GeographicEventRelation(false, true),
      v2AnalyticsEventRelation(false),
      v2WebsiteSummaryEventRelation(),
      v2QualityAuditRelation(),
      ...v2NativeRelations(),
    ];
    for (const sql of relations) {
      expect(sql).not.toContain('warehouse_publication');
      expect(sql).not.toContain('argMax(');
      expect(sql).not.toContain('warehouse_control_projection');
    }
    expect(v2ReportingLogRelation({}, ['id', 'reporting_crawler_id'])).toContain(v2Tables.logs);
    expect(v2BrowserEventRelation()).toContain(v2Tables.browserEvents);
    expect(v2QualityAuditRelation()).toContain(v2Tables.browserEvents);
  });

  it('respects LIEKAN_WAREHOUSE_V2 and upstream CLICKHOUSE_URL precedence', () => {
    const prevBackend = process.env.LIEKAN_ANALYTICS_BACKEND;
    const prevV2 = process.env.LIEKAN_WAREHOUSE_V2;
    const prevCh = process.env.CLICKHOUSE_URL;
    try {
      delete process.env.CLICKHOUSE_URL;
      process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
      delete process.env.LIEKAN_WAREHOUSE_V2;
      expect(warehouseV2Enabled()).toBe(true);

      process.env.LIEKAN_WAREHOUSE_V2 = '0';
      expect(warehouseV2Enabled()).toBe(false);

      process.env.LIEKAN_WAREHOUSE_V2 = '1';
      process.env.CLICKHOUSE_URL = 'http://upstream:8123';
      expect(warehouseV2Enabled()).toBe(false);
    } finally {
      if (prevBackend === undefined) delete process.env.LIEKAN_ANALYTICS_BACKEND;
      else process.env.LIEKAN_ANALYTICS_BACKEND = prevBackend;
      if (prevV2 === undefined) delete process.env.LIEKAN_WAREHOUSE_V2;
      else process.env.LIEKAN_WAREHOUSE_V2 = prevV2;
      if (prevCh === undefined) delete process.env.CLICKHOUSE_URL;
      else process.env.CLICKHOUSE_URL = prevCh;
    }
  });

  it('deletes a session and rebuilds touched browser aggregate hours cleanly', async () => {
    const commands: string[] = [];
    const mockCh = {
      query: vi.fn(async () => ({
        json: async () => [{ h: '2026-11-21 10:00:00' }],
      })),
      command: vi.fn(async ({ query }: { query: string }) => {
        commands.push(query);
      }),
    };
    const { deleteV2Session } = await import('./lifecycle');
    const res = await deleteV2Session(
      mockCh as any,
      '11111111-1111-1111-1111-111111111111',
      '2',
      '22222222-2222-2222-2222-222222222222',
    );
    expect(res.hoursRebuilt).toBe(1);
    expect(commands.some(q => q.includes(`DELETE`) && q.includes(v2Tables.browserEvents))).toBe(true);
    expect(commands.some(q => q.includes(`INSERT INTO ${v2Tables.observationHourAgg}`))).toBe(true);
    expect(commands.some(q => q.includes(`INSERT INTO ${v2Tables.browserPathHourAgg}`))).toBe(true);
  });

  it('reads browser presence directly from ch_v2_browser_events without PG locks', async () => {
    const mockCh = {
      query: vi.fn(async () => ({
        json: async () => [
          {
            firstAt: '2026-11-20 01:00:00.000000',
            lastAt: '2026-11-21 12:34:56.000000',
          },
        ],
      })),
    };
    const { readV2BrowserPresence } = await import('./lifecycle');
    const presence = await readV2BrowserPresence(
      mockCh as any,
      '11111111-1111-1111-1111-111111111111',
      '1',
      new Date('2026-11-01T00:00:00Z'),
    );
    expect(presence.received).toBe(true);
    expect(presence.known).toBe(true);
    expect(presence.lastAt).toBe('2026-11-21T12:34:56.000Z');
  });

  it('preserves bare UTC warehouseTime strings without local timezone shift', async () => {
    const { toV2Timestamp } = await import('./ingest');
    expect(toV2Timestamp('2026-11-25 15:38:00.123456')).toBe('2026-11-25 15:38:00.123456');
    expect(toV2Timestamp('2026-11-25T15:38:00.123Z')).toBe('2026-11-25 15:38:00.123000');
  });

  it('fails closed in readV2ControlContext when userId is missing unless internalBypassAuth is set', async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [
        {
          website_id: '11111111-1111-1111-1111-111111111111',
          domain: 'www.example.com',
          epoch: '1',
          policy_mode: 'standard',
          policy_revision: '0',
          allowed_hostnames: [],
          catalog_version: 'empty:0',
          sources: [],
          authorized: true,
        },
      ],
    }));
    const mockPg = { query } as unknown as PgReadClient;
    expect(await readV2ControlContext(mockPg, '11111111-1111-1111-1111-111111111111')).toBeNull();
    expect(
      await readV2ControlContext(mockPg, '11111111-1111-1111-1111-111111111111', ''),
    ).toBeNull();
    expect(query).not.toHaveBeenCalled();

    const bypassed = await readV2ControlContext(
      mockPg,
      '11111111-1111-1111-1111-111111111111',
      undefined,
      { internalBypassAuth: true },
    );
    expect(bypassed?.websiteId).toBe('11111111-1111-1111-1111-111111111111');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('WHEN $2::uuid IS NULL THEN false');
  });

  it('pushes matched browserPaths filter into browserSql before GROUPING SETS for path-filtered reconciliation', async () => {
    const executed: Array<{ query: string; params: Record<string, unknown> }> = [];
    const mockCh = {
      query: vi.fn(async (arg: { query: string; query_params?: Record<string, unknown> }) => {
        executed.push({ query: arg.query, params: arg.query_params ?? {} });
        if (arg.query.includes(v2Tables.browserPathHourAgg) || arg.query.includes(v2Tables.browserEvents)) {
          return {
            json: async () => [
              {
                is_total: 1,
                url_path: '',
                out_pv: '2',
                out_uv: '2',
                out_visits: '2',
                out_unknown_host_pv: '0',
                out_last_at: '2026-11-26 01:00:00.000000',
              },
              {
                is_total: 0,
                url_path: '/articles/chatgpt-traffic',
                out_pv: '2',
                out_uv: '2',
                out_visits: '2',
                out_unknown_host_pv: '0',
                out_last_at: '2026-11-26 01:00:00.000000',
              },
            ],
          };
        }
        return { json: async () => [] };
      }),
    } as unknown as ClickHouseClient;

    const control = {
      websiteId: '11111111-1111-1111-1111-111111111111',
      domain: 'www.example.com',
      epoch: '1',
      policyMode: 'standard',
      policyRevision: '1',
      allowedHostnames: ['example.com'],
      catalogVersion: 'v1',
      sources: [],
      browserConnected: true,
    };

    const rec = await queryV2Reconciliation(
      mockCh,
      control,
      {
        key: 'k',
        paths: ['/p1', '/articles/chatgpt-traffic'],
        mappings: buildCatalogMappings(['/p1', '/articles/chatgpt-traffic']),
        hash: 'h',
      },
      {
        startAt: Date.UTC(2026, 10, 25, 0, 0, 0),
        endAt: Date.UTC(2026, 10, 26, 0, 0, 0),
        hostname: 'example.com',
        path: '/articles/chatgpt-traffic',
      },
    );

    const browserCall = executed.find(
      c => c.query.includes(v2Tables.browserPathHourAgg) || c.query.includes(v2Tables.browserEvents),
    );
    expect(browserCall).toBeDefined();
    expect(browserCall!.query).toContain('url_path IN {browser_paths:Array(String)}');
    expect(browserCall!.params.browser_paths).toEqual(['/articles/chatgpt-traffic']);
    expect(rec.browserTotals).toEqual({ pv: 2, uv: 2, visits: 2 });
    expect(rec.rows).toHaveLength(1);
    expect(rec.rows[0].pv).toBe(2);
    expect(rec.rows[0].uv).toBe(2);

    // Unmatched path skips browser query and reports zero browser totals instead of full host totals
    const beforeCalls = executed.length;
    const unmatched = await queryV2Reconciliation(
      mockCh,
      control,
      {
        key: 'k',
        paths: ['/p1'],
        mappings: buildCatalogMappings(['/p1']),
        hash: 'h',
      },
      {
        startAt: Date.UTC(2026, 10, 25, 0, 0, 0),
        endAt: Date.UTC(2026, 10, 26, 0, 0, 0),
        hostname: 'example.com',
        path: '/does-not-exist',
      },
    );
    expect(executed.length).toBe(beforeCalls + 1); // only logSql ran
    expect(unmatched.browserTotals).toEqual({ pv: 0, uv: 0, visits: 0 });
  });

  it('maps LogRecord.time, LogRecord.type, and AutomaticRecord.crawlerEvidence accurately and rejects missing timestamps', async () => {
    const { mapV2UploadRecord } = await import('./write-adapters');
    const row = mapV2UploadRecord(
      {
        batchId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        websiteId: '11111111-1111-1111-1111-111111111111',
      },
      '2',
      null,
      '100',
      {
        id: 'log-yesterday-1',
        time: '2026-11-24T14:30:00.000Z',
        path: '/articles/backfill',
        method: 'GET',
        status: 200,
        bytes: 2048,
        ipMasked: '203.0.113.0/24',
        ipHash: 'h1',
        userAgent: 'GPTBot/1.2',
        location: '未知',
        bot: 'GPTBot',
        vendor: 'OpenAI',
        type: '训练',
        aiEligible: true,
        crawlerEvidence: {
          securityAction: 'allow',
          terminatingRuleId: 'a'.repeat(32),
          matchedRuleIds: ['a'.repeat(32)],
          cacheStatus: 'hit',
          durationMs: 42,
          edgeObservation: {
            fields: {
              EdgeResponseContentType: { state: 'present', value: 'text/html' },
            },
          },
        },
      },
      0,
    );
    expect(row.created_at).toBe('2026-11-24 14:30:00.000000');
    expect(row.bot_type).toBe('训练');
    expect(row.security_action).toBe('allow');
    expect(row.cache_status).toBe('hit');
    expect(row.duration_ms).toBe(42);
    expect(row.content_type_state).toBe('present');
    expect(row.content_type_value).toBe('text/html');

    expect(() =>
      mapV2UploadRecord(
        {
          batchId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          websiteId: '11111111-1111-1111-1111-111111111111',
        },
        '2',
        null,
        '100',
        { id: 'missing-time', path: '/' },
        0,
      ),
    ).toThrow('warehouse-v2-log-missing-timestamp');
  });
});
