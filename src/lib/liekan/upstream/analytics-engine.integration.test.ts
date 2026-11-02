// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SHARE_CONTEXT_HEADER } from '@/lib/constants';

const auth = vi.hoisted(() => ({ user: null as any }));
vi.mock('@/lib/auth', () => ({
  checkAuth: async () => auth.user,
  hasPermission: async (role: string) => role === 'admin',
}));
const enabled = process.env.LIEKAN_ANALYTICS_ENGINE_TEST === '1';
let db: typeof import('./analysis-rollups-db'),
  api: typeof import('./analytics-engine'),
  worker: typeof import('./analytics-engine-worker'),
  reader: typeof import('./analytics-engine-read'),
  ch: typeof import('./analytics-engine-clickhouse');
const admin = randomUUID(),
  site = randomUUID(),
  imported = randomUUID();
const start = new Date('2026-01-01T00:00:00Z'),
  end = new Date('2026-01-01T02:00:00Z');
const q = (sql: string, ...p: any[]) =>
  db.analysisTransaction(tx => tx.$queryRawUnsafe<any[]>(sql, ...p));
const exec = (sql: string, ...p: any[]) =>
  db.analysisTransaction(tx => tx.$executeRawUnsafe(sql, ...p));
const request = (method = 'GET', headers = {}) =>
  new Request('http://localhost/api/liekan/admin/analytics-engine', { method, headers });
async function act(action: string) {
  const status = await api.engineStatus(admin);
  return api.changeAnalyticsEngine(request('POST'), {
    action,
    requestId: randomUUID(),
    expectedRevision: status.revision,
    locale: 'zh-CN',
  });
}
const input = (extra: any = {}) => ({
  websiteId: site,
  startDate: start,
  endDate: end,
  timezone: 'Asia/Shanghai',
  crawlerMetricsVersion: 1 as const,
  crawlerIdentityScope: 'all' as const,
  ...extra,
});
async function finish() {
  await worker.discoverEngineWork(true);
  for (let i = 0; i < 30; i++) if (!(await worker.runEngineBatch())) return;
  throw new Error('Engine did not finish bounded fixture');
}
async function log(at: string, options: any = {}) {
  const id = randomUUID();
  await exec(
    `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
    VALUES($1,$2::uuid,$3::uuid,$4::timestamptz,$5,'GET',$6,0,'','',$7,'',$8,'OpenAI',$9,$10,$11::boolean,$12)`,
    id,
    site,
    imported,
    at,
    options.path || '/a%2Fb',
    options.status || 200,
    options.self ? 'Liekan-Crawler-Check/test' : 'GPTBot/test',
    options.bot || 'GPTBot',
    options.type || '训练',
    options.verification || 'verified_range',
    options.ai === undefined ? true : options.ai,
    options.state === undefined ? 'recognized' : options.state,
  );
  return id;
}
const canonical = (v: any): any =>
  v && typeof v === 'object'
    ? Array.isArray(v)
      ? v.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : Object.fromEntries(
          Object.keys(v)
            .filter(k => k !== 'coverage')
            .sort()
            .map(k => [k, canonical(v[k])]),
        )
    : typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)
      ? new Date(v).toISOString()
      : v;

describe.skipIf(!enabled)('optional ClickHouse analytics on owned databases', () => {
  beforeAll(async () => {
    db = await import('./analysis-rollups-db');
    api = await import('./analytics-engine');
    worker = await import('./analytics-engine-worker');
    reader = await import('./analytics-engine-read');
    ch = await import('./analytics-engine-clickhouse');
    await exec(
      "INSERT INTO \"user\"(user_id,username,password,role) VALUES($1::uuid,$2,'isolated-fixture','admin')",
      admin,
      `engine-${admin}`,
    );
    await exec(
      "INSERT INTO website(website_id,name,domain,user_id) VALUES($1::uuid,'Engine integration fixture','engine.example.invalid',$2::uuid)",
      site,
      admin,
    );
    await exec(
      'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$3,10,0)',
      imported,
      site,
      randomUUID(),
    );
    auth.user = { authType: 'session', user: { id: admin, role: 'admin' } };
  }, 30000);
  afterAll(async () => {
    if (enabled) {
      await ch?.engineClient().close();
      const prisma = (await import('@/lib/prisma')).default;
      await prisma.client.$disconnect();
    }
  });
  it('keeps original reads when disabled and rejects incomplete, shared and non-admin identities', async () => {
    expect(await reader.readClickHouseLogRollup(input())).toBeNull();
    expect((await api.getAnalyticsEngine(request())).enabled).toBe(false);
    for (const value of [
      { authType: 'api-key', user: { id: admin, role: 'admin' } },
      { authType: 'session', shareToken: 'shared', user: { id: admin, role: 'admin' } },
      { authType: '2fa', user: null },
    ]) {
      auth.user = value;
      await expect(api.getAnalyticsEngine(request())).rejects.toMatchObject({ status: 401 });
    }
    auth.user = { authType: 'session', user: { id: admin, role: 'admin' } };
    await expect(
      api.getAnalyticsEngine(request('GET', { [SHARE_CONTEXT_HEADER]: 'x' })),
    ).rejects.toMatchObject({ status: 401 });
    await expect(act('enable')).rejects.toMatchObject({ code: 'engine-not-ready' });
  });
  it('copies all historical facts, verifies candidates, and publishes only complete units', async () => {
    await log('2026-01-01T00:05:00.123456Z');
    await log('2026-01-01T00:15:00Z', { path: '/a%2Fb', ai: null, status: 404 });
    await log('2026-01-01T01:15:00Z', { path: '/b', self: true });
    await log('2026-01-01T01:20:00Z', { path: '/c', state: 'unknown', bot: '其他', ai: null });
    await log('2026-01-01T01:25:00Z', { path: '/d', ai: false, verification: 'unverified' });
    expect((await act('check')).healthy).toBe(true);
    await act('prepare');
    await worker.runEngineBatch();
    expect(await reader.readClickHouseLogRollup(input())).toBeNull();
    await finish();
    await act('enable');
    const status = await api.engineStatus(admin);
    expect(status.sites.find(s => s.websiteId === site)?.completed).toBe('2');
    expect((await reader.readClickHouseLogRollup(input()))?.summary).toMatchObject({
      requests: 4,
      ai: 3,
      pages: 2,
      abnormal: 1,
      legacyRequests: 2,
      unclassifiedRequests: 1,
    });
  });
  it('can disable after a malformed deployment setting and preserves upstream ClickHouse mode', async () => {
    const original = process.env.LIEKAN_ANALYTICS_CLICKHOUSE_URL;
    try {
      process.env.LIEKAN_ANALYTICS_CLICKHOUSE_URL = 'invalid';
      expect((await act('disable')).enabled).toBe(false);
    } finally {
      process.env.LIEKAN_ANALYTICS_CLICKHOUSE_URL = original;
    }
    try {
      process.env.CLICKHOUSE_URL = 'http://upstream.example.invalid';
      await expect(act('resume')).rejects.toMatchObject({ status: 503 });
    } finally {
      process.env.CLICKHOUSE_URL = '';
    }
    await act('resume');
    await finish();
    await act('enable');
  });
  it('transports a full year of hourly generation parameters within default HTTP field limits', async () => {
    const generations = Array.from({ length: 8784 }, () => randomUUID());
    const [result] = await ch.engineQuery(
      'SELECT length({generations:Array(UUID)}) AS n,toUUID({id:String}) IN {generations:Array(UUID)} AS present',
      { generations, id: generations.at(-1) },
    );
    expect(result.n).toBe(generations.length);
    expect(result.present).toBe(1);
  });
  it('matches exact PostgreSQL aggregates across scopes, timezone boundaries and legacy windows', async () => {
    const { readAnalysisLogRollup } = await import('./analysis-rollups');
    for (const options of [
      {},
      { crawlerIdentityScope: 'verified_range' },
      { crawlerIdentityScope: 'verified_identity' },
      { timezone: 'America/New_York' },
      { timezone: 'utc' },
      { crawlerMetricsVersion: undefined, endDate: new Date(+end - 1) },
      { filters: { resource: 'ai/pages', botType: '训练' } },
      { filters: { resource: 'ai/bots', botCategory: 'other' } },
      {
        startDate: new Date('2026-01-01T00:05:00.123Z'),
        endDate: new Date('2026-01-01T01:20:00Z'),
      },
    ]) {
      const actual = await reader.readClickHouseLogRollup(input(options));
      const expected = await readAnalysisLogRollup(input({ ...options, allowRawOnly: true }));
      expect(actual, `ClickHouse query must execute: ${JSON.stringify(options)}`).not.toBeNull();
      expect(expected).not.toBeNull();
      expect(canonical(actual)).toEqual(canonical(expected));
    }
    expect(
      await reader.readClickHouseLogRollup(input({ filters: { unsupported: 'x' } })),
    ).toBeNull();
    expect(await reader.readClickHouseLogRollup(input({ endDate: new Date() }))).toBeNull();
    const { readAnalysisLogSeries } = await import('./analysis-rollups');
    for (const grain of ['hour', 'day', 'month'] as const) {
      for (const timezone of ['UTC', 'Asia/Kolkata', 'America/New_York']) {
        const actual = await reader.readClickHouseLogSeries(input({ grain, timezone }));
        const expected = await readAnalysisLogSeries(
          input({ grain, timezone, allowRawOnly: true }),
        );
        expect(actual).not.toBeNull();
        expect(expected).not.toBeNull();
        expect(canonical(actual)).toEqual(canonical(expected));
      }
    }
  });
  it('invalidates late inserts, modifications and deletions before serving, then rebuilds without duplicates', async () => {
    const id = await log('2026-01-01T00:30:00Z', { path: '/late' });
    expect(await reader.readClickHouseLogRollup(input())).toBeNull();
    await finish();
    expect((await reader.readClickHouseLogRollup(input()))?.summary.requests).toBe(5);
    await exec(
      "UPDATE liekan_log SET path='/changed' WHERE website_id=$1::uuid AND id=$2",
      site,
      id,
    );
    expect(await reader.readClickHouseLogRollup(input())).toBeNull();
    await finish();
    await exec('DELETE FROM liekan_log WHERE website_id=$1::uuid AND id=$2', site, id);
    expect(await reader.readClickHouseLogRollup(input())).toBeNull();
    await finish();
    expect((await reader.readClickHouseLogRollup(input()))?.summary.requests).toBe(4);
  });
  it('fences paused work and repeats verification, with audited idempotent operations', async () => {
    const before = await api.engineStatus(admin),
      requestId = randomUUID();
    const body = {
      action: 'disable',
      requestId,
      expectedRevision: before.revision,
      locale: 'en-US',
    };
    await api.changeAnalyticsEngine(request('POST'), body);
    await api.changeAnalyticsEngine(request('POST'), body);
    expect((await api.engineStatus(admin)).revision).toBe(before.revision + 1);
    expect(await reader.readClickHouseLogRollup(input())).toBeNull();
    expect(await worker.runEngineBatch()).toBe(false);
    await expect(
      api.changeAnalyticsEngine(request('POST'), { ...body, action: 'enable' }),
    ).rejects.toMatchObject({ status: 409 });
    await act('resume');
    await act('verify');
    await finish();
    await act('enable');
    expect(await reader.readClickHouseLogRollup(input())).not.toBeNull();
    expect(
      (
        await q(
          'SELECT locale FROM liekan_analytics_engine_operation WHERE request_id=$1::uuid',
          requestId,
        )
      )[0].locale,
    ).toBe('en-US');
  });

  it('proves empty calendar boundaries and canonicalizes accepted timezone aliases', async () => {
    const result = await reader.readClickHouseLogRollup(
      input({
        startDate: new Date('2025-12-31T16:00:00Z'),
        endDate: new Date('2026-01-01T16:00:00Z'),
        timezone: 'utc',
      }),
    );
    expect(result?.summary.requests).toBe(4);
    const empty = await reader.readClickHouseLogRollup(
      input({ startDate: new Date('2025-12-30'), endDate: new Date('2025-12-31') }),
    );
    expect(empty?.summary.requests).toBe(0);
  });
  it('keeps historical coverage valid when another hour receives ordinary crawler evidence', async () => {
    const id = await log('2026-01-01T02:15:00Z');
    await exec(
      "INSERT INTO liekan_crawler_evidence(website_id,log_id,classification_version) VALUES($1::uuid,$2,'fixture')",
      site,
      id,
    );
    expect((await reader.readClickHouseLogRollup(input()))?.summary.requests).toBe(4);
    await exec('DELETE FROM liekan_log WHERE website_id=$1::uuid AND id=$2', site, id);
    await finish();
  });
  it('fills intervening empty hours after a later partial-hour insertion in a non-integral session timezone', async () => {
    await db.analysisTransaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Kolkata'");
      await tx.$executeRawUnsafe(
        `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
         VALUES($1,$2::uuid,$3::uuid,'2026-01-01T04:15:00Z','/later','GET',200,0,'','','','','GPTBot','OpenAI','训练','verified_range',true,'recognized')`,
        randomUUID(),
        site,
        imported,
      );
    });
    await finish();
    const units = await q(
      'SELECT bucket FROM liekan_analytics_engine_unit WHERE website_id=$1::uuid ORDER BY bucket',
      site,
    );
    expect(units.map(u => new Date(u.bucket).toISOString())).toContain('2026-01-01T03:00:00.000Z');
    expect(
      (await reader.readClickHouseLogRollup(input({ endDate: new Date('2026-01-01T05:00:00Z') })))
        ?.summary.requests,
    ).toBe(5);
    await exec("DELETE FROM liekan_log WHERE website_id=$1::uuid AND path='/later'", site);
    await finish();
  });
  it('records first-chunk failures and enforces the four-attempt budget', async () => {
    await act('verify');
    await worker.discoverEngineWork(true);
    const spy = vi
      .spyOn(ch.engineClient(), 'insert')
      .mockRejectedValue(new Error('simulated transport failure'));
    try {
      for (let i = 0; i < 4; i++) {
        await expect(worker.runEngineBatch()).rejects.toThrow('simulated transport failure');
        const [row] = await q(
          'SELECT attempts,error_code FROM liekan_analytics_engine_unit WHERE website_id=$1::uuid AND bucket=$2',
          site,
          start,
        );
        expect(row.attempts).toBe(i + 1);
        expect(row.error_code).toBe('engine-sync-failed');
        await exec(
          'UPDATE liekan_analytics_engine_unit SET retry_at=NULL WHERE website_id=$1::uuid AND bucket=$2',
          site,
          start,
        );
      }
    } finally {
      spy.mockRestore();
    }
    expect((await api.engineStatus(admin)).sites.find(s => s.websiteId === site)?.failed).toBe('1');
    await act('retry');
    await finish();
    await act('enable');
  });
  it('releases PostgreSQL locks during external writes and rejects publication after pause', async () => {
    await act('verify');
    await worker.discoverEngineWork(true);
    const client = ch.engineClient(),
      original = client.insert.bind(client);
    let release: () => void, entered: () => void;
    const gate = new Promise<void>(r => {
        release = r;
      }),
      inside = new Promise<void>(r => {
        entered = r;
      });
    const spy = vi.spyOn(client, 'insert').mockImplementationOnce(async args => {
      entered();
      await gate;
      return original(args);
    });
    const pending = worker.runEngineBatch();
    await inside;
    try {
      const began = performance.now();
      const id = await log('2026-01-01T02:25:00Z');
      expect(performance.now() - began).toBeLessThan(1000);
      await act('pause');
      await exec('DELETE FROM liekan_log WHERE website_id=$1::uuid AND id=$2', site, id);
    } finally {
      release();
      await pending;
      spy.mockRestore();
    }
    expect(await reader.readClickHouseLogRollup(input())).toBeNull();
    await act('resume');
    await finish();
    await act('enable');
  });
  it('rejects an expired writer lease and safely resumes its already written chunk', async () => {
    await act('verify');
    await worker.discoverEngineWork(true);
    const client = ch.engineClient(),
      original = client.insert.bind(client);
    let release: () => void, entered: () => void;
    const gate = new Promise<void>(r => {
        release = r;
      }),
      inside = new Promise<void>(r => {
        entered = r;
      });
    const spy = vi.spyOn(client, 'insert').mockImplementationOnce(async args => {
      entered();
      await gate;
      return original(args);
    });
    const pending = worker.runEngineBatch();
    await inside;
    try {
      await exec(
        "UPDATE liekan_analytics_engine_unit SET lease_until=clock_timestamp()-interval '1 second' WHERE website_id=$1::uuid AND bucket=$2",
        site,
        start,
      );
    } finally {
      release();
      await pending;
      spy.mockRestore();
    }
    expect(
      (
        await q(
          'SELECT copied::text FROM liekan_analytics_engine_unit WHERE website_id=$1::uuid AND bucket=$2',
          site,
          start,
        )
      )[0].copied,
    ).toBe('0');
    await finish();
    await act('enable');
    expect((await reader.readClickHouseLogRollup(input()))?.summary.requests).toBe(4);
  });
  it('falls back and rebuilds when a published ClickHouse generation is missing', async () => {
    const [unit] = await q(
      'SELECT generation FROM liekan_analytics_engine_unit WHERE website_id=$1::uuid AND bucket=$2',
      site,
      start,
    );
    await ch.engineClient().command({
      query: `ALTER TABLE ${ch.ENGINE_TABLE} DELETE WHERE generation={g:UUID}`,
      query_params: { g: unit.generation },
      clickhouse_settings: { mutations_sync: '1' },
    });
    expect(await reader.readClickHouseLogRollup(input())).toBeNull();
    await finish();
    expect((await reader.readClickHouseLogRollup(input()))?.summary.requests).toBe(4);
  });
  it('contains query errors and recovers a transient connectivity fence while idle', async () => {
    const spy = vi.spyOn(ch, 'engineQuery');
    spy.mockRejectedValueOnce(new Error('query budget'));
    expect(await reader.readClickHouseLogRollup(input())).toBeNull();
    expect((await api.engineStatus(admin)).healthy).toBe(true);
    spy.mockRejectedValueOnce(new Error('network')).mockRejectedValueOnce(new Error('network'));
    expect(await reader.readClickHouseLogRollup(input())).toBeNull();
    expect((await api.engineStatus(admin)).healthy).toBe(false);
    spy.mockRestore();
    await worker.pumpAnalyticsEngine();
    expect((await api.engineStatus(admin)).healthy).toBe(true);
  });
  it('isolates garbage collection by installation on a shared external database', async () => {
    const [sample] = await ch.engineQuery(
      `SELECT * FROM ${ch.ENGINE_TABLE} WHERE website_id={site:UUID} LIMIT 1`,
      { site },
    );
    expect(sample).toBeTruthy();
    const outsider = randomUUID(),
      orphan = randomUUID(),
      otherGeneration = randomUUID();
    await ch.engineClient().insert({
      table: ch.ENGINE_TABLE,
      format: 'JSONEachRow',
      values: [
        { ...sample, generation: orphan, inserted_at: '2026-01-01T00:00:00Z' },
        {
          ...sample,
          installation_id: outsider,
          generation: otherGeneration,
          inserted_at: '2026-01-01T00:00:00Z',
        },
      ],
      clickhouse_settings: { date_time_input_format: 'best_effort' },
    });
    await worker.collectEngineGarbage();
    expect(
      (
        await ch.engineQuery(
          `SELECT count() AS n FROM ${ch.ENGINE_TABLE} WHERE generation={g:UUID}`,
          { g: orphan },
        )
      )[0].n,
    ).toBe(0);
    expect(
      (
        await ch.engineQuery(
          `SELECT count() AS n FROM ${ch.ENGINE_TABLE} WHERE generation={g:UUID}`,
          { g: otherGeneration },
        )
      )[0].n,
    ).toBe(1);
    await ch.engineClient().command({
      query: `ALTER TABLE ${ch.ENGINE_TABLE} DELETE WHERE installation_id={owner:UUID}`,
      query_params: { owner: outsider },
      clickhouse_settings: { mutations_sync: '1' },
    });
  });
  it('does not claim dirty markers belonging to an unlocked ninth website', async () => {
    const ids = Array.from({ length: 9 }, () => randomUUID()).sort();
    await exec(
      "INSERT INTO website(website_id,name,domain,user_id) SELECT id,'Lock-order fixture','locks.example.invalid',$2::uuid FROM unnest($1::uuid[]) id",
      ids,
      admin,
    );
    await exec(
      'INSERT INTO liekan_analytics_engine_site(website_id) SELECT id FROM unnest($1::uuid[]) id',
      ids,
    );
    await exec(
      'INSERT INTO liekan_analytics_engine_dirty(website_id,bucket,shard) SELECT id,$2,0 FROM unnest($1::uuid[]) id',
      ids,
      start,
    );
    let release: () => void, entered: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
      }),
      inside = new Promise<void>(resolve => {
        entered = resolve;
      });
    const locking = db.analysisTransaction(async tx => {
      await tx.$queryRawUnsafe(
        'SELECT 1 FROM liekan_analytics_engine_site WHERE website_id=$1::uuid FOR UPDATE',
        ids.at(-1),
      );
      entered();
      await gate;
    });
    let discovery: Promise<void>, timer: ReturnType<typeof setTimeout>;
    try {
      await inside;
      discovery = worker.discoverEngineWork(true);
      await Promise.race([
        discovery,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Discovery waited for the unlocked ninth website')),
            1000,
          );
        }),
      ]);
      expect(
        (
          await q(
            'SELECT pending FROM liekan_analytics_engine_dirty WHERE website_id=$1::uuid',
            ids.at(-1),
          )
        )[0].pending,
      ).toBe(true);
    } finally {
      clearTimeout(timer);
      release();
      await locking;
      await discovery;
      await exec('DELETE FROM website WHERE website_id=ANY($1::uuid[])', ids);
      await exec('DELETE FROM liekan_analytics_engine_site WHERE website_id=ANY($1::uuid[])', ids);
    }
  });
  it('serves live synchronization while a large sweep-only tombstone backlog is due', async () => {
    const ids = Array.from({ length: 20 }, () => randomUUID());
    await exec(
      'INSERT INTO liekan_analytics_engine_site(website_id,purge_through,sweep_targets) SELECT id,1,ARRAY[$2] FROM unnest($1::uuid[]) id',
      ids,
      ch.engineConnection().key,
    );
    try {
      await act('verify');
      await worker.discoverEngineWork(true);
      for (let i = 0; i < 8; i++) await worker.runEngineBatch();
      const [unit] = await q(
        'SELECT verified_at FROM liekan_analytics_engine_unit WHERE website_id=$1::uuid AND bucket=$2',
        site,
        start,
      );
      expect(unit.verified_at).not.toBeNull();
    } finally {
      await exec('DELETE FROM liekan_analytics_engine_site WHERE website_id=ANY($1::uuid[])', ids);
    }
    await finish();
    await act('enable');
  });
  it('denies stale permissions and purges the analysis copy after a website reset', async () => {
    const [old] = await ch.engineQuery(
      `SELECT * FROM ${ch.ENGINE_TABLE} WHERE website_id={site:UUID} LIMIT 1`,
      { site },
    );
    await exec('UPDATE "user" SET role=\'user\' WHERE user_id=$1::uuid', admin);
    await expect(api.getAnalyticsEngine(request())).rejects.toMatchObject({ status: 403 });
    await exec('UPDATE website SET reset_at=clock_timestamp() WHERE website_id=$1::uuid', site);
    expect(await reader.readClickHouseLogRollup(input())).toBeNull();
    await worker.discoverEngineWork(true);
    const client = ch.engineClient(),
      original = client.command.bind(client);
    const spy = vi.spyOn(client, 'command').mockImplementationOnce(async args => {
      const result = await original(args);
      await exec(
        "UPDATE liekan_analytics_engine_site SET purge_until=clock_timestamp()-interval '1 second' WHERE website_id=$1::uuid",
        site,
      );
      return result;
    });
    await worker.runEngineBatch();
    spy.mockRestore();
    expect(
      (
        await q(
          'SELECT purge_pending FROM liekan_analytics_engine_site WHERE website_id=$1::uuid',
          site,
        )
      )[0].purge_pending,
    ).toBe(true);
    await worker.runEngineBatch();
    await exec('UPDATE "user" SET role=\'admin\' WHERE user_id=$1::uuid', admin);
    expect((await api.engineStatus(admin)).syncing).toBe(false);
    expect(
      (
        await ch.engineQuery(
          `SELECT count() AS n FROM ${ch.ENGINE_TABLE} WHERE website_id={site:UUID}`,
          { site },
        )
      )[0].n,
    ).toBe(0);
    await client.insert({
      table: ch.ENGINE_TABLE,
      format: 'JSONEachRow',
      values: [old],
      clickhouse_settings: { date_time_input_format: 'best_effort' },
    });
    await exec(
      'UPDATE liekan_analytics_engine_site SET purge_checked_at=NULL WHERE website_id=$1::uuid',
      site,
    );
    await worker.runEngineBatch();
    expect(
      (
        await ch.engineQuery(
          `SELECT count() AS n FROM ${ch.ENGINE_TABLE} WHERE website_id={site:UUID}`,
          { site },
        )
      )[0].n,
    ).toBe(0);
  });
  it('can restore one cleanup destination when other sites still require a different destination', async () => {
    const a = ch.engineConnection().key,
      b = 'b'.repeat(64),
      other = randomUUID();
    await exec(
      'INSERT INTO liekan_analytics_engine_site(website_id,purge_pending,pending_targets) VALUES($1::uuid,true,ARRAY[$2])',
      other,
      b,
    );
    await exec(
      'UPDATE liekan_analytics_engine_site SET purge_pending=true,pending_targets=ARRAY[$2] WHERE website_id=$1::uuid',
      site,
      a,
    );
    await exec('UPDATE liekan_analytics_engine SET connection_hash=$1 WHERE id=1', 'c'.repeat(64));
    expect((await act('check')).healthy).toBe(true);
    expect(
      (
        await q(
          'SELECT pending_targets FROM liekan_analytics_engine_site WHERE website_id=$1::uuid',
          other,
        )
      )[0].pending_targets,
    ).toEqual([b]);
    await exec('DELETE FROM liekan_analytics_engine_site WHERE website_id=$1::uuid', other);
    await worker.runEngineBatch();
  });
  it.skipIf(process.env.LIEKAN_ENGINE_VISUAL !== '1')(
    'prepares real fixture coverage for isolated browser verification',
    async () => {
      await act('prepare');
      await finish();
      await act('enable');
    },
  );
});
