// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogHash } from '../crawlers/catalog-validation';
import type { CatalogPayload } from '../contracts/crawler-registry';
import { evidenceManifestDigest } from '../history-repair/model';
import {
  historyRepairDetailSchema,
  historyRepairListSchema,
  HISTORY_REPAIR_CAMPAIGN,
  type HistoryRepairRun,
} from '../contracts/history-repair';
let scanHistoryRepair: typeof import('./history-repair').scanHistoryRepair;
let getHistoryRepair: typeof import('./history-repair').getHistoryRepair;
let listHistoryRepair: typeof import('./history-repair').listHistoryRepair;
let previewHistoryRepair: typeof import('./history-repair').previewHistoryRepair;
let confirmHistoryRepair: typeof import('./history-repair').confirmHistoryRepair;
let actHistoryRepair: typeof import('./history-repair').actHistoryRepair;
let ingestHistoryRepairEvidence: typeof import('./history-repair').ingestHistoryRepairEvidence;
let exportHistoryRepair: typeof import('./history-repair').exportHistoryRepair;
let processHistoryRepairJob: typeof import('./history-repair').processHistoryRepairJob;
let clearHistoryRepair: typeof import('./history-repair').clearHistoryRepair;
let invalidateHistoryRepair: typeof import('./history-repair').invalidateHistoryRepair;
let reconcileHistoryRepairs: typeof import('./history-repair').reconcileHistoryRepairs;
let repairTransaction: typeof import('./history-repair-db').repairTransaction;
let collectionRepairScope: typeof import('./history-repair-boundary').collectionRepairScope;
let getQueue: typeof import('../log-ingestion/queue').getQueue;
let prisma: typeof import('@/lib/prisma').default;
const enabled = process.env.LIEKAN_HISTORY_REPAIR_TEST === '1';
const actor = { userId: randomUUID() };
const other = { userId: randomUUID() };
const browserFixtureUa =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const q = <T = Record<string, unknown>[]>(sql: string, ...values: unknown[]) =>
  repairTransaction(tx => tx.$queryRawUnsafe<T>(sql, ...values));
const execute = (sql: string, ...values: unknown[]) =>
  repairTransaction(tx => tx.$executeRawUnsafe(sql, ...values));
let site: string, session: string, first: string;
const scan = () =>
  scanHistoryRepair(site, { actionId: randomUUID(), timezone: 'America/New_York' }, actor);
const status = async () => (await getHistoryRepair(site, new URLSearchParams(), actor)).run;
async function finish(run: HistoryRepairRun, identity = actor) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = (await getHistoryRepair(site, new URLSearchParams(), identity)).run;
    if (!['scanning', 'preparing', 'queued', 'running', 'validating'].includes(current.status))
      return current;
    await processHistoryRepairJob({ runId: run.id });
  }
  throw new Error('Bounded worker did not finish');
}
async function event(
  at: string | null,
  options: {
    id?: string;
    session?: string;
    source?: string | null;
    classification?: string;
    reasons?: string[];
    rule?: string;
    type?: number;
  } = {},
) {
  const id = options.id || randomUUID(),
    sid = options.session || session;
  await execute(
    `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type,hostname) VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,$4::timestamptz,'/fixture',$5,'example.test')`,
    id,
    site,
    sid,
    at,
    options.type || 1,
  );
  if (options.source !== null)
    await execute(
      `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status,hostname) VALUES($1::uuid,$2::uuid,$3,$4,$5::text[],$6,'missing','example.test')`,
      id,
      site,
      options.classification || 'unknown',
      options.source || 'browser',
      options.reasons || ['ua_unrecognized'],
      options.rule || 'traffic-quality-v3',
    );
  return id;
}
async function proveFixtureIdentities() {
  await execute(`INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available)
    SELECT event_id,website_id,'browser','cookieless-trusted-input-v2',true FROM website_event WHERE website_id=$1::uuid
    ON CONFLICT(event_id) DO NOTHING`,site);
}
async function log(ua = 'GPTBot/1.0') {
  const imported = randomUUID();
  const id = randomUUID().replaceAll('-', '').repeat(2);
  await execute(
    'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$3,1,0)',
    imported,
    site,
    randomUUID(),
  );
  await execute(
    `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification) VALUES($1,$2::uuid,$3::uuid,'2020-01-01T00:00:00.000001Z','/fixture','GET',200,0,'','',$4,'','其他','','其他','unverified')`,
    id,
    site,
    imported,
    ua,
  );
  return id;
}
async function evidenceFile(run: HistoryRepairRun, ua: string, identity = actor) {
  const uploadId = randomUUID();
  const append = await ingestHistoryRepairEvidence(
    site,
    {
      runId: run.id,
      action: 'append',
      actionId: randomUUID(),
      uploadId,
      expectedRevision: run.revision,
      sequence: 0,
      source: 'retention fixture',
      records: [{ eventId: first, requestUserAgent: ua }],
    },
    identity,
  );
  const finalized = await ingestHistoryRepairEvidence(
    site,
    {
      runId: run.id,
      action: 'finalize',
      actionId: randomUUID(),
      uploadId,
      expectedRevision: append.revision,
      chunks: 1,
      rows: 1,
      manifest: [append.hash],
    },
    identity,
  );
  return { uploadId, revision: finalized.revision };
}
async function publishCatalogFixture(payload: CatalogPayload) {
  return repairTransaction(async tx => {
    const [current] = await tx.$queryRawUnsafe<{ revision: string }[]>(
      'SELECT revision::text FROM liekan_crawler_registry_current WHERE id=1 FOR UPDATE',
    );
    const version = randomUUID(),
      revision = (BigInt(current.revision) + 1n).toString();
    await tx.$executeRawUnsafe(
      "INSERT INTO liekan_crawler_registry_version(version,revision,content_hash,payload,action) VALUES($1::uuid,$2::bigint,$3,$4::jsonb,'publish')",
      version,
      revision,
      catalogHash(payload),
      JSON.stringify(payload),
    );
    await tx.$executeRawUnsafe(
      'UPDATE liekan_crawler_registry_current SET version=$1::uuid,revision=$2::bigint WHERE id=1',
      version,
      revision,
    );
    return version;
  });
}
async function productFormLogFixture() {
  const { loadPublishedRegistry } = await import('./crawler-registry-context');
  const base = await loadPublishedRegistry();
  const oldPayload = structuredClone(base.payload);
  oldPayload.identities.find(identity => identity.id === 'gptbot').productForm = 'general';
  const oldVersion = await publishCatalogFixture(oldPayload);
  const payload = structuredClone(oldPayload);
  payload.identities.find(identity => identity.id === 'gptbot').productForm = 'workbench';
  const currentVersion = await publishCatalogFixture(payload);
  const id = await log();
  await execute(
    "UPDATE liekan_log SET bot='GPTBot',vendor='OpenAI',bot_type='训练',ai_eligible=true,recognition_state='recognized',recognition_candidates='[]',verification='verified_range',verification_version='original-range',verification_observed_at='2019-01-01T00:00:00Z',verification_reason='original-proof' WHERE website_id=$1::uuid AND id=$2",
    site,
    id,
  );
  await execute(
    'INSERT INTO liekan_crawler_evidence(website_id,log_id,crawler_id,catalog_version,classification_version,identity_evidence) VALUES($1::uuid,$2,\'gptbot\',$3::uuid,\'original-classification\',\'{"subjectId":"gptbot","status":"verified_range"}\'::jsonb)',
    site,
    id,
    oldVersion,
  );
  return { id, oldVersion, currentVersion, restore: () => publishCatalogFixture(base.payload) };
}
describe.skipIf(!enabled)('history repair on an owned isolated PostgreSQL schema', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || 'http://invalid');
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '15460' ||
      url.pathname !== '/liekan_history_repair_test' ||
      !/^history_[a-f0-9]+$/.test(url.searchParams.get('schema') || '')
    )
      throw new Error('Only owned PostgreSQL15460 history schema is allowed');
    ({
      scanHistoryRepair,
      getHistoryRepair,
      listHistoryRepair,
      previewHistoryRepair,
      confirmHistoryRepair,
      actHistoryRepair,
      ingestHistoryRepairEvidence,
      exportHistoryRepair,
      processHistoryRepairJob,
      clearHistoryRepair,
      invalidateHistoryRepair,
      reconcileHistoryRepairs,
    } = await import('./history-repair'));
    ({ repairTransaction } = await import('./history-repair-db'));
    ({ collectionRepairScope } = await import('./history-repair-boundary'));
    ({ getQueue } = await import('../log-ingestion/queue'));
    ({ default: prisma } = await import('@/lib/prisma'));
    for (const user of [actor, other])
      await execute(
        'INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$2,$3,\'user\')',
        user.userId,
        user.userId,
        'fixture',
      );
  });
  afterAll(async () => {
    if (!enabled) return;
    await (await getQueue()).stop();
    await prisma.client.$disconnect();
  });
  beforeEach(async () => {
    site = randomUUID();
    session = randomUUID();
    await execute(
      "INSERT INTO website(website_id,name,domain,user_id) VALUES($1::uuid,'Repair fixture','example.test',$2::uuid)",
      site,
      actor.userId,
    );
    await execute(
      'INSERT INTO session(session_id,website_id) VALUES($1::uuid,$2::uuid)',
      session,
      site,
    );
    await execute(
      'UPDATE liekan_history_repair_campaign SET eligible_websites=array_append(eligible_websites,$2::uuid) WHERE id=$1',
      HISTORY_REPAIR_CAMPAIGN,
      site,
    );
    await execute(
      "INSERT INTO liekan_worker_state(id,version) VALUES('fixture-history-worker','history-repair-v1.2') ON CONFLICT(id) DO UPDATE SET heartbeat_at=clock_timestamp(),version=EXCLUDED.version",
    );
    first = await event('2020-01-01T00:00:00.000001Z');
  });
  it('aggregates fresh property statistics within the native statement budget', async () => {
    const { getEventDataStats } = await import('@/queries/sql/events/getEventDataStats');
    const { reportSnapshot } = await import('./server');
    await execute(
      `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type,event_name)
       SELECT gen_random_uuid(),$1::uuid,$2::uuid,$2::uuid,'2020-01-02'::timestamptz+n*interval '1 second','/properties',2,'property-budget'
       FROM generate_series(1,153) n`,
      site,
      session,
    );
    await execute(
      `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status)
       SELECT event_id,website_id,'browser','browser','{}','traffic-quality-v3','missing'
       FROM website_event WHERE website_id=$1::uuid AND event_type=2`,
      site,
    );
    await execute(
      `INSERT INTO event_data(event_data_id,website_id,website_event_id,data_key,string_value,data_type,created_at)
       SELECT gen_random_uuid(),e.website_id,e.event_id,'key-'||n,'value',1,e.created_at
       FROM website_event e CROSS JOIN generate_series(1,10) n
       WHERE e.website_id=$1::uuid AND e.event_type=2`,
      site,
    );
    const result = await reportSnapshot(
      () =>
        getEventDataStats(site, {
          startDate: new Date('2020-01-02'),
          endDate: new Date('2020-01-03'),
        }),
      Date.now() + 2000,
    );
    expect({
      events: Number(result.events),
      properties: Number(result.properties),
      records: Number(result.records),
    }).toEqual({ events: 153, properties: 10, records: 1530 });
  });
  it('preserves late properties, sibling filters and per-site property windows', async () => {
    const { getEventDataStats } = await import('@/queries/sql/events/getEventDataStats');
    const { getEventDataEvents } = await import('@/queries/sql/events/getEventDataEvents');
    const { getEventDataFields } = await import('@/queries/sql/events/getEventDataFields');
    const { getEventDataById } = await import('@/queries/sql/events/getEventDataById');
    const { getEventDataNumericSeries } = await import(
      '@/queries/sql/events/getEventDataNumericSeries'
    );
    const { getEventDataNumericStats } = await import(
      '@/queries/sql/events/getEventDataNumericStats'
    );
    const { getEventDataPivot } = await import('@/queries/sql/events/getEventDataPivot');
    const { getWebsiteEvents } = await import('@/queries/sql/events/getWebsiteEvents');
    const filters = {
      startDate: new Date('2020-01-02'),
      endDate: new Date('2020-01-03'),
      timezone: 'UTC',
      unit: 'day',
    };
    await execute(
      "UPDATE website_event SET event_type=2,event_name='late-property' WHERE event_id=$1::uuid",
      first,
    );
    const current = await event('2020-01-02T01:00:00Z', { type: 2 });
    const withoutProperties = await event('2020-01-02T02:00:00Z', { type: 2 });
    await execute(
      "UPDATE website_event SET event_name='purchase' WHERE event_id=$1::uuid",
      current,
    );
    const property = (
      eventId: string,
      key: string,
      value: string,
      at: string,
      type = 1,
      amount: number | null = null,
      websiteId = site,
    ) =>
      execute(
        `INSERT INTO event_data(event_data_id,website_id,website_event_id,data_key,string_value,number_value,data_type,created_at)
         VALUES(gen_random_uuid(),$1::uuid,$2::uuid,$3,$4,$5,$6,$7::timestamptz)`,
        websiteId,
        eventId,
        key,
        value,
        amount,
        type,
        at,
      );
    await property(first, 'late', 'old-parent', '2020-01-02');
    await property(current, 'revenue', '10.0000', '2020-01-02T01:00:00Z', 2, 10);
    await property(current, 'currency', 'USD', '2020-01-03');
    await property(current, 'outside', 'future', '2020-01-04');
    for (const options of [
      { classification: 'automated' },
      { source: 'legacy_override' },
      { source: 'authenticated_server' },
    ]) {
      const excluded = await event('2020-01-02T03:00:00Z', { ...options, type: 2 });
      await property(excluded, 'excluded', 'not-browser-population', '2020-01-02');
    }
    const otherSite = randomUUID(),
      otherSession = randomUUID(),
      otherEvent = randomUUID();
    await execute(
      "INSERT INTO website(website_id,name,user_id) VALUES($1::uuid,'Other property site',$2::uuid)",
      otherSite,
      actor.userId,
    );
    await execute(
      'INSERT INTO session(session_id,website_id) VALUES($1::uuid,$2::uuid)',
      otherSession,
      otherSite,
    );
    await execute(
      `INSERT INTO website_event(event_id,website_id,session_id,visit_id,event_type,created_at,event_name,url_path)
       VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,2,'2020-01-02','other-site','/properties')`,
      otherEvent,
      otherSite,
      otherSession,
    );
    await execute(
      `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status)
       VALUES($1::uuid,$2::uuid,'browser','browser','{}','traffic-quality-v3','missing')`,
      otherEvent,
      otherSite,
    );
    await property(otherEvent, 'other-site', 'outside-site', '2020-01-02', 1, null, otherSite);
    const stats = await getEventDataStats(site, filters);
    expect([Number(stats.events), Number(stats.properties), Number(stats.records)]).toEqual([
      1, 2, 2,
    ]);
    const events = await getEventDataEvents(site, filters);
    expect(
      events.map(row => `${row.eventName}:${row.propertyName}:${Number(row.total)}`).sort(),
    ).toEqual(['late-property:late:1', 'purchase:currency:1', 'purchase:revenue:1']);
    expect(
      (await getEventDataFields(site, undefined, filters)).map(row => row.propertyName).sort(),
    ).toEqual(['currency', 'revenue']);
    const currency = {
      propertyName: 'currency',
      dataType: 1,
      operator: 'eq',
      value: 'USD',
    } as const;
    const series = await getEventDataNumericSeries(site, 'purchase', 'revenue', 'sum', filters, [
      currency,
    ]);
    expect(series.map(row => Number(row.y))).toEqual([10]);
    const filteredStats = await getEventDataNumericStats(site, 'purchase', 'revenue', {
      ...filters,
      eventPropertyFilters: [currency],
    });
    expect(Number(filteredStats.total)).toBe(10);
    const pivot = await getEventDataPivot(site, 'purchase', filters, [currency]);
    expect(Number(pivot.count)).toBe(1);
    expect(pivot.data.map(row => row.propertyKeys)).toEqual([['currency', 'revenue']]);
    const websiteEvents = await getWebsiteEvents(site, filters);
    expect(websiteEvents.data.map(row => [row.id, row.hasData]).sort()).toEqual(
      [
        [current, true],
        [withoutProperties, false],
      ].sort(),
    );
    expect((await getEventDataById(site, current)).map(row => row.dataKey).sort()).toEqual([
      'currency',
      'outside',
      'revenue',
    ]);
  });
  it.each(['event properties', 'sessions', 'event pivot'] as const)(
    'keeps uncached native %s count and rows in one repair generation',
    async kind => {
      const { getEventData } = await import('@/queries/sql/events/getEventData');
      const { getWebsiteSessions } = await import('@/queries/sql/sessions/getWebsiteSessions');
      const { getEventDataPivot } = await import('@/queries/sql/events/getEventDataPivot');
      const { cacheHeadersEnabled } = await import('./cache-context');
      const secondSession = randomUUID();
      await execute(
        'INSERT INTO session(session_id,website_id) VALUES($1::uuid,$2::uuid)',
        secondSession,
        site,
      );
      const second = await event('2020-01-01T00:00:01Z', {
        session: secondSession,
        reasons: ['ua_bot'],
        type: 2,
      });
      await execute(
        "UPDATE website_event SET event_type=2,event_name='snapshot-fixture' WHERE website_id=$1::uuid",
        site,
      );
      for (const id of [first, second])
        await execute(
          "INSERT INTO event_data(event_data_id,website_id,website_event_id,data_key,string_value,data_type,created_at) VALUES(gen_random_uuid(),$1::uuid,$2::uuid,'label','fixture',1,'2020-01-01')",
          site,
          id,
        );
      await proveFixtureIdentities();
      const prepared = await finish(await scan());
      let published = false;
      const intercept =
        (raw: (sql: string, ...values: unknown[]) => Promise<unknown>) =>
        async (sql: string, ...values: unknown[]) => {
          const value = await raw(sql, ...values);
          if (!published && /select count\(\*\) as num/i.test(sql)) {
            published = true;
            await execute(
              'UPDATE liekan_history_repair_run SET active_generation=generation,active_revision=active_revision+1 WHERE id=$1::uuid',
              prepared.id,
            );
          }
          return value;
        };
      const direct = prisma.client.$queryRawUnsafe;
      const transaction: any = prisma.client.$transaction.bind(prisma.client);
      vi.spyOn(prisma.client, '$queryRawUnsafe').mockImplementation(function (
        this: typeof prisma.client,
        sql: string,
        ...values: unknown[]
      ) {
        return intercept(direct.bind(this))(sql, ...values) as any;
      });
      vi.spyOn(prisma.client, '$transaction').mockImplementation(((work: any, options: any) =>
        transaction(
          (tx: any) =>
            work(
              new Proxy(tx, {
                get(target, property) {
                  const value = Reflect.get(target, property);
                  if (property === '$queryRawUnsafe') return intercept(value.bind(target));
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              }),
            ),
          options,
        )) as any);
      const filters = {
        startDate: new Date('2019-01-01'),
        endDate: new Date('2021-01-01'),
        event: 'eq.snapshot-fixture',
        pageSize: 100,
      };
      const read = () =>
        kind === 'event properties'
          ? getEventData(site, filters)
          : kind === 'event pivot'
            ? getEventDataPivot(site, 'snapshot-fixture', filters)
            : getWebsiteSessions(site, filters);
      const ids = (result: any) =>
        result.data.map((row: any) => (kind !== 'sessions' ? row.eventId : row.id)).sort();
      expect(cacheHeadersEnabled()).toBe(false);
      const before = await read();
      expect(published).toBe(true);
      expect(Number(before.count)).toBe(2);
      expect(ids(before)).toEqual(
        (kind !== 'sessions' ? [first, second] : [session, secondSession]).sort(),
      );
      const after = await read();
      expect(Number(after.count)).toBe(1);
      expect(ids(after)).toEqual([kind !== 'sessions' ? first : session]);
    },
  );
  it('keeps policy preview on the collection-original classification population after repair', async () => {
    const { previewTrafficPolicy, saveTrafficPolicy } = await import('./traffic-quality');
    await execute(
      "UPDATE liekan_event_quality SET classification='browser',reasons=ARRAY['ua_bot'] WHERE event_id=$1::uuid",
      first,
    );
    const prepared = await finish(await scan());
    await finish(
      await confirmHistoryRepair(
        site,
        {
          runId: prepared.id,
          actionId: randomUUID(),
          expectedRevision: prepared.revision,
          generation: prepared.generation,
          previewDigest: prepared.preview.digest,
          partialConfirmed: true,
        },
        actor,
      ),
    );
    await saveTrafficPolicy(site, { mode: 'raw', allowedHostnames: [] }, actor);
    const range = {
      startAt: +new Date('2020-01-01'),
      endAt: +new Date('2020-01-02'),
      timezone: 'UTC',
    };
    for (const classification of ['browser', 'automated'] as const) {
      const result = await previewTrafficPolicy(
        site,
        {
          policy: { mode: 'raw', allowedHostnames: [] },
          range: { ...range, classification },
        },
        actor,
      );
      const expected = classification === 'browser' ? 1 : 0;
      expect(result.current.rawPV).toBe(expected);
      expect(result.preview).toEqual(result.current);
      const standard = await previewTrafficPolicy(
        site,
        {
          policy: { mode: 'standard', allowedHostnames: [] },
          range: { ...range, classification },
        },
        actor,
      );
      expect(standard.preview.rawPV).toBe(expected);
      expect(standard.preview.rawUV).toBe(expected ? null : 0);
      expect(standard.preview.includedPV).toBe(0);
    }
  });
  it('lets the current manager regenerate a preview after the original actor leaves the team', async () => {
    const { mutateTeamMember } = await import('./team-member-access');
    const teamId = randomUUID();
    await execute("INSERT INTO team(team_id,name) VALUES($1::uuid,'Repair team')", teamId);
    for (const [member, role] of [
      [actor, 'team-member'],
      [other, 'team-owner'],
    ] as const)
      await execute(
        'INSERT INTO team_user(team_user_id,team_id,user_id,role) VALUES($1::uuid,$2::uuid,$3::uuid,$4)',
        randomUUID(),
        teamId,
        member.userId,
        role,
      );
    await execute(
      'UPDATE website SET user_id=NULL,team_id=$2::uuid WHERE website_id=$1::uuid',
      site,
      teamId,
    );
    await log();
    const prepared = await finish(await scan());
    expect(prepared.status).toBe('ready');
    await mutateTeamMember(other.userId, teamId, actor.userId, 'remove');
    const file = await evidenceFile(prepared, 'GPTBot/1.0', other);
    const regenerated = await previewHistoryRepair(
      site,
      {
        runId: prepared.id,
        actionId: randomUUID(),
        expectedRevision: file.revision,
      },
      other,
    );
    const done = await finish(regenerated, other);
    expect(done.status).toBe('ready');
    expect(
      (
        await q<{ actor_id: string }[]>(
          'SELECT actor_id::text FROM liekan_history_repair_run WHERE id=$1::uuid',
          prepared.id,
        )
      )[0].actor_id,
    ).toBe(other.userId);
    await expect(getHistoryRepair(site, new URLSearchParams(), actor)).rejects.toMatchObject({
      status: 403,
    });
  });
  it('returns stable schemas and omits new websites from campaign eligibility', async () => {
    const list = await listHistoryRepair(actor);
    expect(historyRepairListSchema.safeParse(list).success).toBe(true);
    expect(list.hasEligibleData).toBe(true);
    const detail = await getHistoryRepair(site, new URLSearchParams(), actor);
    expect(historyRepairDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.run).toBeNull();
    const fresh = randomUUID();
    await execute(
      "INSERT INTO website(website_id,name,user_id) VALUES($1::uuid,'New fixture',$2::uuid)",
      fresh,
      actor.userId,
    );
    expect((await getHistoryRepair(fresh, new URLSearchParams(), actor)).eligible).toBe(false);
    await expect(scanHistoryRepair(fresh, { actionId: randomUUID() }, actor)).rejects.toMatchObject(
      { status: 409, code: 'history-repair-ineligible' },
    );
    const malformed = Buffer.from(
      JSON.stringify({ scope: `list:${actor.userId}`, after: 'bad' }),
    ).toString('base64url');
    await expect(
      listHistoryRepair(actor, new URLSearchParams({ cursor: malformed })),
    ).rejects.toMatchObject({ status: 409, code: 'history-repair-cursor-conflict' });
  });
  it('rejects fixed-offset scans and stores a canonical IANA timezone with correct natural days', async () => {
    for (const timezone of ['+01:00', '-05:30'])
      await expect(
        scanHistoryRepair(site, { actionId: randomUUID(), timezone }, actor),
      ).rejects.toMatchObject({ status: 400, code: 'history-repair-invalid-timezone' });
    expect(await status()).toBeNull();
    const run = await finish(
      await scanHistoryRepair(
        site,
        {
          actionId: randomUUID(),
          timezone: 'Asia/Shanghai',
        },
        actor,
      ),
    );
    expect(run.preview.timezone).toBe('Asia/Shanghai');
    const detail = await getHistoryRepair(site, new URLSearchParams({ view: 'days' }), actor);
    expect(detail.days.items.map(day => day.date)).toEqual(['2020-01-01']);
  });
  it('resolves uppercase event and client UUID receipts without changing idempotent UUID semantics', async () => {
    const second = await event('2020-01-01T00:00:00.000002Z');
    const receipt = randomUUID();
    await execute(
      `INSERT INTO liekan_collection_receipt(website_id,client_event_id,payload_hash,event_id) VALUES($1::uuid,$2::uuid,'fixture',$3::uuid)`,
      site,
      receipt,
      second,
    );
    const prepared = await finish(await scan());
    const body = {
      action: 'append',
      runId: prepared.id.toUpperCase(),
      actionId: randomUUID().toUpperCase(),
      uploadId: randomUUID().toUpperCase(),
      expectedRevision: prepared.revision,
      sequence: 0,
      source: 'UUID archive',
      records: [
        { eventId: first.toUpperCase(), requestUserAgent: 'GPTBot/1.0' },
        { clientEventId: receipt.toUpperCase(), requestUserAgent: 'GPTBot/1.0' },
      ],
    };
    const appended = await ingestHistoryRepairEvidence(site, body, actor);
    expect(appended.accepted).toBe(2);
    expect(appended.errors).toEqual([]);
    expect(await ingestHistoryRepairEvidence(site, body, actor)).toEqual(appended);
  });
  it('finalizes an ordered manifest digest and fences mismatched retries', async () => {
    const prepared = await finish(await scan()),
      uploadId = randomUUID();
    const hashes: string[] = [];
    let revision = prepared.revision;
    for (let sequence = 0; sequence < 2; sequence++) {
      const appended = await ingestHistoryRepairEvidence(
        site,
        {
          action: 'append',
          actionId: randomUUID(),
          runId: prepared.id,
          uploadId,
          expectedRevision: revision,
          sequence,
          source: 'digest archive',
          records: [{ eventId: first, requestUserAgent: 'GPTBot/1.0' }],
        },
        actor,
      );
      hashes.push(appended.hash);
      revision = appended.revision;
    }
    const body = {
      action: 'finalize',
      actionId: randomUUID(),
      runId: prepared.id,
      uploadId,
      expectedRevision: revision,
      chunks: 2,
      rows: 2,
      manifestDigest: evidenceManifestDigest(hashes),
    };
    await expect(
      ingestHistoryRepairEvidence(
        site,
        { ...body, manifestDigest: evidenceManifestDigest([...hashes].reverse()) },
        actor,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'history-repair-evidence-incomplete' });
    const finalized = await ingestHistoryRepairEvidence(site, body, actor);
    expect(finalized.finalized).toBe(true);
    expect(await ingestHistoryRepairEvidence(site, body, actor)).toEqual(finalized);
    await expect(
      ingestHistoryRepairEvidence(site, { ...body, rows: 3 }, actor),
    ).rejects.toMatchObject({ status: 409, code: 'history-repair-action-conflict' });
  });
  it('confirms a large upload manifest with a compact digest below the body limit', async () => {
    const prepared = await finish(await scan()),
      uploadId = randomUUID();
    await execute(
      `INSERT INTO liekan_history_repair_input(run_id,website_id,upload_id,sequence,chunk_hash,rulepack_hash,source,actor_id,rows,accepted,errors,records,generation)
      SELECT r.id,r.website_id,$2::uuid,n,repeat('a',64),r.snapshot->'rulepack'->>'hash','large manifest fixture',$3::uuid,1,1,'[]','[]',r.generation FROM liekan_history_repair_run r CROSS JOIN generate_series(0,15999) n WHERE r.id=$1::uuid`,
      prepared.id,
      uploadId,
      actor.userId,
    );
    const body = {
      action: 'finalize',
      actionId: randomUUID(),
      runId: prepared.id,
      uploadId,
      expectedRevision: prepared.revision,
      chunks: 16000,
      rows: 16000,
      manifestDigest: evidenceManifestDigest(Array.from({ length: 16000 }, () => 'a'.repeat(64))),
    };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(1024);
    expect((await ingestHistoryRepairEvidence(site, body, actor)).finalized).toBe(true);
  });
  it('prepares a complete candidate while original rows and reporting remain unchanged until confirmation', async () => {
    await log();
    const prepared = await finish(await scan());
    expect(prepared.status).toBe('ready');
    expect(prepared.progress).toBe(95);
    expect(prepared.counts.changedLogs).toBe('1');
    expect(prepared.preview.logImpact).toMatchObject({
      beforeIdentities: '0',
      afterIdentities: '1',
      beforeAiPages: '0',
      afterAiPages: '1',
    });
    expect(
      prepared.preview.logImpact.categories.find(row => row.category === 'training'),
    ).toMatchObject({ beforeRequests: '0', afterRequests: '1' });
    const [raw] = await q<{ bot: string }[]>(
      'SELECT bot FROM liekan_log WHERE website_id=$1::uuid',
      site,
    );
    const [reported] = await q<{ bot: string }[]>(
      'SELECT bot FROM liekan_reporting_log WHERE website_id=$1::uuid',
      site,
    );
    expect(raw.bot).toBe('其他');
    expect(reported.bot).toBe('其他');
    await expect(
      confirmHistoryRepair(
        site,
        {
          actionId: randomUUID(),
          runId: (await status()).id,
          expectedRevision: prepared.revision,
          generation: prepared.generation,
          previewDigest: prepared.preview.digest,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'history-repair-partial-confirmation-required' });
    const confirmed = await confirmHistoryRepair(
      site,
      {
        actionId: randomUUID(),
        runId: (await status()).id,
        expectedRevision: prepared.revision,
        generation: prepared.generation,
        previewDigest: prepared.preview.digest,
        partialConfirmed: true,
      },
      actor,
    );
    const completed = await finish(confirmed);
    expect(completed.status).toBe('completed_limited');
    expect(completed.progress).toBe(100);
    expect(
      (
        await q<{ bot: string }[]>(
          'SELECT bot FROM liekan_reporting_log WHERE website_id=$1::uuid',
          site,
        )
      )[0].bot,
    ).toBe('GPTBot');
    expect(
      (
        await q<{ bot: string }[]>(
          'SELECT bot FROM liekan_effective_log WHERE website_id=$1::uuid',
          site,
        )
      )[0].bot,
    ).toBe('其他');
  });
  it('makes action UUIDs idempotent and rejects changes to the same payload', async () => {
    const input = { actionId: randomUUID(), timezone: 'UTC' };
    const a = await scanHistoryRepair(site, input, actor),
      b = await scanHistoryRepair(site, input, actor);
    expect(b).toEqual(a);
    await expect(
      scanHistoryRepair(site, { ...input, timezone: 'Asia/Shanghai' }, actor),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('distinguishes missing input, unchanged proven automation and empty sites', async () => {
    expect((await finish(await scan())).status).toBe('unidentifiable');
    const another = await event('2020-01-02', { classification: 'automated', reasons: ['ua_bot'] });
    // New fixture rows arrive through the current receiver and retain the post-freeze scope.
    await execute(
      'UPDATE liekan_event_quality SET repair_scope_id=$2::uuid WHERE event_id=$1::uuid',
      another,
      (await status()).scopeId,
    );
    const rescan = await scan();
    expect((await finish(rescan)).status).toBe('unidentifiable');
    await clearHistoryRepairInFixture();
    await execute('DELETE FROM website_event WHERE website_id=$1::uuid', site);
    expect((await finish(await scan())).status).toBe('empty');
  });
  it('rejects exact evidence with wrong source, missing quality or a different website', async () => {
    const legacy = await event('2020-01-02', { source: 'legacy_override' }),
      missing = await event('2020-01-03', { source: null });
    const prepared = await finish(await scan());
    const result = await ingestHistoryRepairEvidence(
      site,
      {
        action: 'append',
        actionId: randomUUID(),
        uploadId: randomUUID(),
        runId: (await status()).id,
        expectedRevision: prepared.revision,
        sequence: 0,
        source: 'collection HTTP archive',
        records: [
          { eventId: legacy, requestUserAgent: 'GPTBot/1.0' },
          { eventId: missing, requestUserAgent: 'GPTBot/1.0' },
          { eventId: randomUUID(), requestUserAgent: 'GPTBot/1.0' },
        ],
      },
      actor,
    );
    expect(result.accepted).toBe(0);
    expect(result.errors).toHaveLength(3);
    await expect(
      previewHistoryRepair(
        site,
        { actionId: randomUUID(), runId: (await status()).id, expectedRevision: result.revision },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'history-repair-evidence-incomplete' });
  });
  it('classifies transient supplied UA, resolves client UUID receipts and preserves event-local custom events', async () => {
    const custom = await event('2020-01-01T00:00:01Z', { type: 2 });
    const clientId = randomUUID();
    await execute(
      `INSERT INTO liekan_collection_receipt(website_id,client_event_id,payload_hash,event_id) VALUES($1::uuid,$2::uuid,'fixture',$3::uuid)`,
      site,
      clientId,
      first,
    );
    const prepared = await finish(await scan()),
      uploadId = randomUUID();
    const append = await ingestHistoryRepairEvidence(
      site,
      {
        action: 'append',
        actionId: randomUUID(),
        uploadId,
        runId: (await status()).id,
        expectedRevision: prepared.revision,
        sequence: 0,
        source: 'collector HTTP archive',
        records: [{ clientEventId: clientId, requestUserAgent: 'GPTBot/1.0' }],
      },
      actor,
    );
    const finalized = await ingestHistoryRepairEvidence(
      site,
      {
        action: 'finalize',
        actionId: randomUUID(),
        uploadId,
        runId: (await status()).id,
        expectedRevision: append.revision,
        chunks: 1,
        rows: 1,
        manifest: [append.hash],
      },
      actor,
    );
    const fresh = await finish(
      await previewHistoryRepair(
        site,
        {
          actionId: randomUUID(),
          runId: (await status()).id,
          expectedRevision: finalized.revision,
        },
        actor,
      ),
    );
    expect(fresh.counts.beforePV).toBe('1');
    expect(fresh.counts.afterPV).toBe('0');
    const next = await confirmHistoryRepair(
      site,
      {
        actionId: randomUUID(),
        runId: (await status()).id,
        expectedRevision: fresh.revision,
        generation: fresh.generation,
        previewDigest: fresh.preview.digest,
        partialConfirmed: true,
      },
      actor,
    );
    await finish(next);
    const kept = await q<{ event_id: string }[]>(
      'SELECT event_id::text FROM liekan_effective_website_event WHERE website_id=$1::uuid',
      site,
    );
    expect(kept.map(row => row.event_id)).toEqual([custom]);
    const [input] = await q<{ value: string }[]>(
      'SELECT records::text AS value FROM liekan_history_repair_input WHERE run_id=$1::uuid',
      fresh.id,
    );
    expect(input.value).not.toContain('GPTBot/1.0');
  });
  it('keeps historical identity gaps unavailable in previews, days and export', async () => {
    const prepared = await finish(await scan());
    // v5 PV counts qualified browsers. The observed legacy row retains missing identity evidence.
    expect(prepared.counts.beforePV).toBe('0');
    expect(prepared.counts.beforeUV).toBeNull();
    expect(prepared.preview.metricScope).toBe('qualified-browser');
    expect(prepared.preview.counts.beforeQualifiedUV).toBe('0');
    expect(prepared.preview.counts.beforeIdentityMissingPV).toBe('1');
    const [observed] = await q<{ pv: string }[]>(
      'SELECT count(*)::text AS pv FROM website_event WHERE website_id=$1::uuid AND event_type=1',
      site,
    );
    expect(observed.pv).toBe('1');
    const detail = await getHistoryRepair(site, new URLSearchParams({ view: 'days' }), actor);
    expect(detail.days.items[0].beforeUV).toBeNull();
    expect(detail.days.items[0].beforeIdentityMissingPV).toBe('1');
    const result = await exportHistoryRepair(site, {}, actor);
    expect(result.csv).toContain('原缺失身份PV');
  });
  it('normalizes a pre-upgrade action receipt without rewriting the saved receipt', async () => {
    const body = { actionId: randomUUID(), timezone: 'America/New_York' };
    await scanHistoryRepair(site,body,actor);
    await execute(`UPDATE liekan_history_repair_action SET response=jsonb_set(response,'{counts}',
      ((response->'counts')-'beforeIdentityMissingPV'-'afterIdentityMissingPV'-'beforeQualifiedUV'-'afterQualifiedUV') || '{"beforeUV":"7","afterUV":"7"}'::jsonb) WHERE id=$1::uuid`,body.actionId);
    const replay = await scanHistoryRepair(site,body,actor);
    expect(replay.counts.beforeUV).toBeNull();
    const [saved] = await q<{uv:string}[]>(`SELECT response#>>'{counts,beforeUV}' AS uv FROM liekan_history_repair_action WHERE id=$1::uuid`,body.actionId);
    expect(saved.uv).toBe('7');
  });
  it('aligns repair preview with Origin and confirmed governance and fences a changed governance revision', async () => {
    const excluded = randomUUID();
    await execute(`UPDATE liekan_event_quality SET reasons=ARRAY['ua_bot'] WHERE event_id=$1::uuid`,first);
    await execute(`INSERT INTO liekan_collection_policy(website_id,mode,allowed_hostnames) VALUES($1::uuid,'standard',ARRAY['example.test'])`,site);
    const conflict = await event('2020-01-02Z');
    await event('2020-01-03Z', { classification: 'browser' });
    await proveFixtureIdentities();
    await execute(`UPDATE liekan_event_environment SET origin_hostname='other.test' WHERE event_id=$1::uuid`,conflict);
    await execute(`INSERT INTO liekan_traffic_exclusion(id,website_id,epoch,actor_id,state,base_revision,policy_revision,rule_version,window_end,received_cutoff,membership_digest,evidence,expires_at)
      VALUES($1::uuid,$2::uuid,1,$3::uuid,'active',0,0,'test',now(),now(),repeat('a',64),'{}',now())`,excluded,site,actor.userId);
    await execute(`INSERT INTO liekan_traffic_exclusion_member(website_id,collection_id,event_id) VALUES($1::uuid,$2::uuid,$3::uuid)`,site,excluded,first);
    const prepared = await finish(await scan());
    expect(prepared.preview.counts.beforePV).toBe('1');
    expect(prepared.preview.counts.afterPV).toBe('1');
    await execute(`INSERT INTO liekan_traffic_governance(website_id,revision) VALUES($1::uuid,1)`,site);
    await expect(confirmHistoryRepair(site,{runId:prepared.id,actionId:randomUUID(),expectedRevision:prepared.revision,generation:prepared.generation,previewDigest:prepared.preview.digest,partialConfirmed:true},actor)).rejects.toMatchObject({status:409});
  });
  it('counts whole-range UV independently of daily UV across natural days and years', async () => {
    await event('2025-07-01T05:00:00Z', { reasons: ['ua_bot'] });
    await event('2025-07-02T05:00:00Z');
    await proveFixtureIdentities();
    await log();
    const prepared = await finish(await scan());
    expect(prepared.counts.beforeUV).toBe('1');
    expect(prepared.counts.afterUV).toBe('1');
    const detail = await getHistoryRepair(site, new URLSearchParams({ view: 'days' }), actor);
    expect(detail.days.items.length).toBe(3);
    expect(detail.days.items.reduce((sum, day) => sum + BigInt(day.beforeUV), 0n)).toBe(3n);
  });
  it('preserves full microsecond cursors across a 2000-row boundary without recounting', async () => {
    await execute(
      `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path) SELECT gen_random_uuid(),$1::uuid,$2::uuid,$2::uuid,'2020-01-01'::timestamptz+n*interval '1 microsecond','/bulk' FROM generate_series(2,2005) n`,
      site,
      session,
    );
    await execute(
      `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status) SELECT event_id,website_id,'unknown','browser','{}','traffic-quality-v3','missing' FROM website_event WHERE website_id=$1::uuid AND event_id<>$2::uuid`,
      site,
      first,
    );
    await log();
    const prepared = await finish(await scan());
    expect(prepared.counts.events).toBe('2005');
    expect(prepared.counts.processed).toBe('2006');
    expect(prepared.counts.beforePV).toBe('2005');
  });
  it('detects old receiver NULL writes without rejecting collection and invalidates the pending candidate', async () => {
    await log();
    const prepared = await finish(await scan());
    await event('2020-01-04');
    const changed = await status();
    expect(changed.scopeChanged).toBe(true);
    await expect(
      confirmHistoryRepair(
        site,
        {
          actionId: randomUUID(),
          runId: (await status()).id,
          expectedRevision: prepared.revision,
          generation: prepared.generation,
          previewDigest: prepared.preview.digest,
          partialConfirmed: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'history-repair-scope-changed' });
  });
  it('assigns the frozen scope under website locks and rejects post-freeze evidence', async () => {
    const prepared = await finish(await scan());
    const scoped = await repairTransaction(tx => collectionRepairScope(tx, site));
    expect(scoped).toBe(prepared.scopeId);
    const newer = await event('2019-01-01');
    await execute(
      'UPDATE liekan_event_quality SET repair_scope_id=$2::uuid WHERE event_id=$1::uuid',
      newer,
      scoped,
    );
    // The raw insertion deliberately exercised the old-code trigger; clear only the fixture's alert.
    await execute(
      'UPDATE liekan_history_repair_run SET scope_changed=false WHERE website_id=$1::uuid',
      site,
    );
    const result = await ingestHistoryRepairEvidence(
      site,
      {
        action: 'append',
        actionId: randomUUID(),
        uploadId: randomUUID(),
        runId: (await status()).id,
        expectedRevision: prepared.revision,
        sequence: 0,
        source: 'archive',
        records: [{ eventId: newer, requestUserAgent: 'GPTBot/1.0' }],
      },
      actor,
    );
    expect(result.errors[0].code).toBe('outside-frozen-scope');
  });
  it('lets cancellation win before activation and keeps active overlays across domain/ownership invalidation', async () => {
    await log();
    const prepared = await finish(await scan());
    const confirmed = await confirmHistoryRepair(
      site,
      {
        actionId: randomUUID(),
        runId: (await status()).id,
        expectedRevision: prepared.revision,
        generation: prepared.generation,
        previewDigest: prepared.preview.digest,
        partialConfirmed: true,
      },
      actor,
    );
    await actHistoryRepair(
      site,
      {
        action: 'cancel',
        actionId: randomUUID(),
        runId: (await status()).id,
        expectedRevision: confirmed.revision,
      },
      actor,
    );
    await processHistoryRepairJob(confirmed.id);
    expect((await status()).activeGeneration).toBeNull();
    const next = await finish(await scan());
    const active = await finish(
      await confirmHistoryRepair(
        site,
        {
          actionId: randomUUID(),
          runId: (await status()).id,
          expectedRevision: next.revision,
          generation: next.generation,
          previewDigest: next.preview.digest,
          partialConfirmed: true,
        },
        actor,
      ),
    );
    await repairTransaction(tx => invalidateHistoryRepair(tx, site));
    expect((await status()).activeGeneration).toBe(active.activeGeneration);
    const rolled = await actHistoryRepair(
      site,
      {
        action: 'rollback',
        actionId: randomUUID(),
        runId: (await status()).id,
        expectedRevision: (await status()).revision,
      },
      actor,
    );
    expect(rolled.activeGeneration).toBeNull();
    expect(
      (
        await q<{ bot: string }[]>(
          'SELECT bot FROM liekan_reporting_log WHERE website_id=$1::uuid',
          site,
        )
      )[0].bot,
    ).toBe('其他');
  });
  it('rechecks actor permissions inside the primary transaction and exports a fixed generation without raw UA', async () => {
    await expect(scanHistoryRepair(site, { actionId: randomUUID() }, other)).rejects.toMatchObject({
      status: 403,
    });
    await log();
    const prepared = await finish(await scan());
    const exported = await exportHistoryRepair(
      site,
      new URLSearchParams({ locale: 'en-US' }),
      actor,
    );
    expect(exported.csv).toContain('Before PV');
    expect(exported.csv).not.toContain('GPTBot/1.0');
    const page = await getHistoryRepair(
      site,
      new URLSearchParams({ view: 'actions', pageSize: '1' }),
      actor,
    );
    expect(page.actions.items).toHaveLength(1);
    expect(page.actions.nextCursor).not.toBeNull();
    const second = await getHistoryRepair(
      site,
      new URLSearchParams({ view: 'actions', pageSize: '1', cursor: page.actions.nextCursor }),
      actor,
    );
    expect(second.actions.items[0].id).not.toBe(page.actions.items[0].id);
    expect(prepared.preview.complete).toBe(true);
  });
  it('requires a compatible healthy worker before scan and confirmation', async () => {
    await execute('DELETE FROM liekan_worker_state');
    await expect(scan()).rejects.toMatchObject({
      status: 503,
      code: 'history-repair-worker-unavailable',
    });
    await execute(
      "INSERT INTO liekan_worker_state(id,version) VALUES('fixture-history-worker','1.0.0')",
    );
    await expect(scan()).rejects.toMatchObject({ status: 503 });
    await execute(
      "UPDATE liekan_worker_state SET version='history-repair-v1.2',heartbeat_at=clock_timestamp()",
    );
    await log();
    const prepared = await finish(await scan());
    await execute("UPDATE liekan_worker_state SET version='1.0.0'");
    await expect(
      confirmHistoryRepair(
        site,
        {
          runId: prepared.id,
          actionId: randomUUID(),
          expectedRevision: prepared.revision,
          generation: prepared.generation,
          previewDigest: prepared.preview.digest,
          partialConfirmed: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('requires rollback before replacing an active task and permits correcting its source afterward', async () => {
    const prepared = await finish(await scan()),
      uploadId = randomUUID();
    const append = await ingestHistoryRepairEvidence(
      site,
      {
        runId: prepared.id,
        action: 'append',
        actionId: randomUUID(),
        uploadId,
        expectedRevision: prepared.revision,
        sequence: 0,
        source: 'administrator collector archive',
        records: [{ eventId: first, requestUserAgent: 'GPTBot/1.0' }],
      },
      actor,
    );
    const finalized = await ingestHistoryRepairEvidence(
      site,
      {
        runId: prepared.id,
        action: 'finalize',
        actionId: randomUUID(),
        uploadId,
        expectedRevision: append.revision,
        chunks: 1,
        rows: 1,
        manifest: [append.hash],
      },
      actor,
    );
    const next = await finish(
      await previewHistoryRepair(
        site,
        { runId: prepared.id, actionId: randomUUID(), expectedRevision: finalized.revision },
        actor,
      ),
    );
    const active = await finish(
      await confirmHistoryRepair(
        site,
        {
          runId: next.id,
          actionId: randomUUID(),
          expectedRevision: next.revision,
          generation: next.generation,
          previewDigest: next.preview.digest,
          partialConfirmed: true,
        },
        actor,
      ),
    );
    await expect(scan()).rejects.toMatchObject({ code: 'history-repair-rollback-required' });
    await expect(
      previewHistoryRepair(
        site,
        { runId: active.id, actionId: randomUUID(), expectedRevision: active.revision },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'history-repair-rollback-required' });
    const rolled = await actHistoryRepair(
      site,
      {
        runId: active.id,
        action: 'rollback',
        actionId: randomUUID(),
        expectedRevision: active.revision,
      },
      actor,
    );
    const withdrawn = await ingestHistoryRepairEvidence(
      site,
      {
        runId: active.id,
        action: 'discard',
        actionId: randomUUID(),
        uploadId,
        expectedRevision: rolled.revision,
      },
      actor,
    );
    expect(withdrawn.discarded).toBe(true);
    const retained = await getHistoryRepair(
      site,
      new URLSearchParams({ view: 'preview', generation: active.generation }),
      actor,
    );
    expect(retained.run.preview).toBeNull();
    expect(retained.selectedGeneration.preview.counts.afterPV).toBe('0');
    expect(
      (await exportHistoryRepair(site, { generation: active.generation }, actor)).csv,
    ).toContain(active.generation);
    await expect(
      actHistoryRepair(
        site,
        {
          runId: active.id,
          action: 'resume',
          actionId: randomUUID(),
          expectedRevision: withdrawn.revision,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'history-repair-preview-required' });
    const corrected = await finish(
      await previewHistoryRepair(
        site,
        { runId: active.id, actionId: randomUUID(), expectedRevision: withdrawn.revision },
        actor,
      ),
    );
    expect(corrected.counts.changedEvents).toBe('0');
    const archived = await getHistoryRepair(
      site,
      new URLSearchParams({ view: 'preview', generation: active.generation }),
      actor,
    );
    expect(archived.selectedGeneration.preview.counts.afterPV).toBe('0');
    expect(
      (
        await exportHistoryRepair(
          site,
          new URLSearchParams({ generation: active.generation }),
          actor,
        )
      ).csv,
    ).toContain(active.generation);
    expect(
      (
        await q<{ count: string }[]>(
          'SELECT count(*)::text AS count FROM liekan_history_repair_result WHERE run_id=$1::uuid AND generation=$2::uuid',
          active.id,
          active.generation,
        )
      )[0].count,
    ).toBe('1');
  });
  it('fences stale mutation identities after reset even when the revision restarts at one', async () => {
    const old = await scan();
    await clearHistoryRepairInFixture();
    const current = await scan();
    expect(current.revision).toBe(old.revision);
    expect(current.id).not.toBe(old.id);
    await expect(
      actHistoryRepair(
        site,
        { runId: old.id, action: 'cancel', actionId: randomUUID(), expectedRevision: old.revision },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'history-repair-run-conflict' });
    expect((await status()).status).toBe('scanning');
  });
  it('accounts for undated events without invented dates or browser totals', async () => {
    await event(null);
    await log();
    const prepared = await finish(await scan());
    expect(prepared.counts.events).toBe('2');
    expect(prepared.counts.undatedEvents).toBe('1');
    expect(prepared.counts.beforePV).toBe('1');
    expect(prepared.counts.processed).toBe('3');
    expect(prepared.preview.limitations).toContain('undated-events');
    const days = await getHistoryRepair(site, new URLSearchParams({ view: 'days' }), actor);
    expect(
      days.days.items.reduce((n, day) => n + BigInt(day.eventRows), 0n) +
        BigInt(prepared.counts.undatedEvents),
    ).toBe(BigInt(prepared.counts.events));
  });
  it('cleans expired unsubmitted evidence and recomputes without reusing discarded UA summaries', async () => {
    const prepared = await finish(await scan()),
      uploadId = randomUUID();
    const append = await ingestHistoryRepairEvidence(
      site,
      {
        runId: prepared.id,
        action: 'append',
        actionId: randomUUID(),
        uploadId,
        expectedRevision: prepared.revision,
        sequence: 0,
        source: 'temporary archive',
        records: [{ eventId: first, requestUserAgent: 'GPTBot/1.0' }],
      },
      actor,
    );
    await ingestHistoryRepairEvidence(
      site,
      {
        runId: prepared.id,
        action: 'finalize',
        actionId: randomUUID(),
        uploadId,
        expectedRevision: append.revision,
        chunks: 1,
        rows: 1,
        manifest: [append.hash],
      },
      actor,
    );
    await execute(
      "UPDATE liekan_history_repair_run SET updated_at=clock_timestamp()-interval '8 days' WHERE website_id=$1::uuid",
      site,
    );
    await reconcileHistoryRepairs();
    expect((await status()).status).toBe('expired');
    expect(
      (
        await q<{ count: string }[]>(
          'SELECT count(*)::text AS count FROM liekan_history_repair_input WHERE run_id=$1::uuid',
          prepared.id,
        )
      )[0].count,
    ).toBe('0');
    const rescanned = await finish(await scan());
    expect(rescanned.counts.changedEvents).toBe('0');
  });
  it.each(['unchanged', 'cancelled', 'confirmed cancellation'] as const)(
    'cleans idle %s working evidence while keeping daily summaries and audit',
    async outcome => {
      const prepared = await finish(await scan());
      const file = await evidenceFile(
        prepared,
        outcome === 'unchanged' ? browserFixtureUa : 'GPTBot/1.0',
      );
      let terminal = await finish(
        await previewHistoryRepair(
          site,
          {
            runId: prepared.id,
            actionId: randomUUID(),
            expectedRevision: file.revision,
          },
          actor,
        ),
      );
      if (outcome === 'confirmed cancellation')
        terminal = await confirmHistoryRepair(
          site,
          {
            runId: terminal.id,
            actionId: randomUUID(),
            expectedRevision: terminal.revision,
            generation: terminal.generation,
            previewDigest: terminal.preview.digest,
            partialConfirmed: true,
          },
          actor,
        );
      if (outcome !== 'unchanged')
        terminal = await actHistoryRepair(
          site,
          {
            runId: terminal.id,
            action: 'cancel',
            actionId: randomUUID(),
            expectedRevision: terminal.revision,
          },
          actor,
        );
      expect(terminal.status).toBe(outcome === 'unchanged' ? 'unchanged' : 'cancelled');
      await execute(
        "UPDATE liekan_history_repair_run SET updated_at=clock_timestamp()-interval '8 days',completed_at=clock_timestamp()-interval '8 days' WHERE id=$1::uuid",
        terminal.id,
      );
      await reconcileHistoryRepairs();
      const [retained] = await q<
        { inputs: number; results: number; days: number; actions: number }[]
      >(
        `SELECT (SELECT count(*)::int FROM liekan_history_repair_input WHERE run_id=$1::uuid) AS inputs,
        (SELECT count(*)::int FROM liekan_history_repair_result WHERE run_id=$1::uuid) AS results,
        (SELECT count(*)::int FROM liekan_history_repair_day WHERE run_id=$1::uuid) AS days,
        (SELECT count(*)::int FROM liekan_history_repair_action WHERE run_id=$1::uuid) AS actions`,
        terminal.id,
      );
      expect(retained.inputs).toBe(0);
      expect(retained.results).toBe(0);
      expect(retained.days).toBeGreaterThan(0);
      expect(retained.actions).toBeGreaterThan(0);
      const after = await status();
      expect(after.status).toBe(terminal.status);
      expect(after.counts).toEqual(terminal.counts);
      expect(
        (await exportHistoryRepair(site, { generation: terminal.generation }, actor)).csv,
      ).toContain(terminal.generation);
    },
  );
  it('keeps a new upload usable when its transaction starts before terminal evidence expiry', async () => {
    const prepared = await finish(await scan());
    const oldFile = await evidenceFile(prepared, browserFixtureUa);
    const unchanged = await finish(
      await previewHistoryRepair(
        site,
        {
          runId: prepared.id,
          actionId: randomUUID(),
          expectedRevision: oldFile.revision,
        },
        actor,
      ),
    );
    expect(unchanged.status).toBe('unchanged');
    await execute(
      "UPDATE liekan_history_repair_run SET updated_at=clock_timestamp()-interval '8 days',completed_at=clock_timestamp()-interval '8 days' WHERE id=$1::uuid",
      unchanged.id,
    );
    const transaction: any = prisma.client.$transaction.bind(prisma.client);
    let expired = false;
    const spy = vi.spyOn(prisma.client, '$transaction').mockImplementation(((
      work: any,
      options: any,
    ) =>
      transaction(
        (tx: any) =>
          work(
            new Proxy(tx, {
              get(target, property) {
                const value = Reflect.get(target, property);
                if (property === '$queryRawUnsafe')
                  return async (sql: string, ...values: unknown[]) => {
                    if (!expired && sql.includes('FOR NO KEY UPDATE OF r')) {
                      expired = true;
                      await reconcileHistoryRepairs();
                    }
                    return value.call(target, sql, ...values);
                  };
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ),
        options,
      )) as any);
    const uploadId = randomUUID();
    let appended: Awaited<ReturnType<typeof ingestHistoryRepairEvidence>>;
    try {
      appended = await ingestHistoryRepairEvidence(
        site,
        {
          runId: unchanged.id,
          action: 'append',
          actionId: randomUUID(),
          uploadId,
          expectedRevision: unchanged.revision,
          sequence: 0,
          source: 'arrived during cleanup',
          records: [{ eventId: first, requestUserAgent: 'GPTBot/1.0' }],
        },
        actor,
      );
    } finally {
      spy.mockRestore();
    }
    expect(expired).toBe(true);
    expect(appended.accepted).toBe(1);
    expect(
      (await getHistoryRepair(site, new URLSearchParams(), actor)).uploads.map(upload => upload.id),
    ).toContain(uploadId);
    const finalized = await ingestHistoryRepairEvidence(
      site,
      {
        runId: unchanged.id,
        action: 'finalize',
        actionId: randomUUID(),
        uploadId,
        expectedRevision: appended.revision,
        chunks: 1,
        rows: 1,
        manifest: [appended.hash],
      },
      actor,
    );
    const current = await finish(
      await previewHistoryRepair(
        site,
        {
          runId: unchanged.id,
          actionId: randomUUID(),
          expectedRevision: finalized.revision,
        },
        actor,
      ),
    );
    expect(current.counts.changedEvents).toBe('1');
  });
  it.each(['expiry', 'detection changes', 'old unconfirmed archive'] as const)(
    'does not reuse a partially collected file after %s',
    async cause => {
      const prepared = await finish(await scan()),
        uploadId = randomUUID();
      const hashes = Array.from({ length: 350 }, (_, index) =>
        index.toString(16).padStart(64, '0'),
      );
      const record = {
        eventId: first,
        automated: true,
        reasons: ['ua_bot'],
        hash: 'a'.repeat(64),
        uploadId,
      };
      await execute(
        `INSERT INTO liekan_history_repair_input(run_id,website_id,upload_id,sequence,chunk_hash,rulepack_hash,source,actor_id,rows,accepted,records,generation)
      SELECT r.id,r.website_id,$2::uuid,n-1,hashes[n],r.snapshot->'rulepack'->>'hash','large retained source',$3::uuid,1,1,$4::jsonb,r.generation
      FROM liekan_history_repair_run r CROSS JOIN generate_series(1,350) n CROSS JOIN (SELECT $5::text[] AS hashes) h WHERE r.id=$1::uuid`,
        prepared.id,
        uploadId,
        actor.userId,
        JSON.stringify([record]),
        hashes,
      );
      const finalized = await ingestHistoryRepairEvidence(
        site,
        {
          runId: prepared.id,
          action: 'finalize',
          actionId: randomUUID(),
          uploadId,
          expectedRevision: prepared.revision,
          chunks: 350,
          rows: 350,
          manifestDigest: evidenceManifestDigest(hashes),
        },
        actor,
      );
      const ready = await finish(
        await previewHistoryRepair(
          site,
          { runId: prepared.id, actionId: randomUUID(), expectedRevision: finalized.revision },
          actor,
        ),
      );
      expect(ready.counts.changedEvents).toBe('1');
      if (cause === 'old unconfirmed archive') {
        await actHistoryRepair(
          site,
          {
            runId: ready.id,
            action: 'cancel',
            actionId: randomUUID(),
            expectedRevision: ready.revision,
          },
          actor,
        );
        await execute(
          "UPDATE liekan_history_repair_run SET generation_archive=jsonb_set(generation_archive,ARRAY[$2::text,'archivedAt'],to_jsonb((clock_timestamp()-interval '8 days')::text)) WHERE id=$1::uuid",
          ready.id,
          prepared.generation,
        );
        await reconcileHistoryRepairs();
        const [intact] = await q<{ chunks: number; complete: number }[]>(
          "SELECT count(*)::int AS chunks,count(*) FILTER(WHERE state='finalized')::int AS complete FROM liekan_history_repair_input WHERE run_id=$1::uuid AND upload_id=$2::uuid",
          ready.id,
          uploadId,
        );
        expect(intact).toEqual({ chunks: 350, complete: 350 });
        const next = await finish(await scan());
        expect(next.counts.changedEvents).toBe('1');
        await ingestHistoryRepairEvidence(
          site,
          {
            runId: next.id,
            action: 'discard',
            actionId: randomUUID(),
            uploadId,
            expectedRevision: next.revision,
          },
          actor,
        );
        for (let round = 0; round < 4; round++) await reconcileHistoryRepairs();
        return;
      }
      if (cause === 'expiry') {
        await execute(
          "UPDATE liekan_history_repair_run SET updated_at=clock_timestamp()-interval '8 days' WHERE id=$1::uuid",
          ready.id,
        );
        await reconcileHistoryRepairs();
        expect((await status()).status).toBe('expired');
      } else {
        const previous = process.env.DISABLE_BOT_CHECK;
        try {
          process.env.DISABLE_BOT_CHECK = '1';
          expect((await finish(await scan())).counts.changedEvents).toBe('0');
        } finally {
          if (previous === undefined) delete process.env.DISABLE_BOT_CHECK;
          else process.env.DISABLE_BOT_CHECK = previous;
        }
      }
      const rescanned = await finish(await scan());
      expect(rescanned.counts.changedEvents).toBe('0');
      expect(rescanned.preview.sourceUploads).toEqual([]);
      const renewed = await evidenceFile(rescanned, browserFixtureUa);
      const renewedPreview = await finish(
        await previewHistoryRepair(
          site,
          { runId: rescanned.id, actionId: randomUUID(), expectedRevision: renewed.revision },
          actor,
        ),
      );
      expect(renewedPreview.counts.changedEvents).toBe('0');
      expect(renewedPreview.counts.browserEvidence).toBe('1');
      for (let round = 0; round < 4; round++) await reconcileHistoryRepairs();
      const [cleaned] = await q<{ old: number; fresh: number }[]>(
        'SELECT count(*) FILTER(WHERE upload_id=$2::uuid)::int AS old,count(*) FILTER(WHERE upload_id=$3::uuid)::int AS fresh FROM liekan_history_repair_input WHERE run_id=$1::uuid',
        ready.id,
        uploadId,
        renewed.uploadId,
      );
      expect(cleaned).toEqual({ old: 0, fresh: 1 });
    },
  );
  it.each(['active', 'previous'] as const)(
    'preserves complete archived %s sources during bounded expiry cleanup',
    async pointer => {
      const prepared = await finish(await scan()),
        protectedUpload = randomUUID(),
        unusedUpload = randomUUID(),
        protectedGeneration = randomUUID();
      const records = [
        {
          eventId: first,
          automated: false,
          reasons: [],
          hash: 'a'.repeat(64),
          uploadId: protectedUpload,
        },
      ];
      await execute(
        `INSERT INTO liekan_history_repair_input(run_id,website_id,upload_id,sequence,chunk_hash,rulepack_hash,source,actor_id,rows,accepted,errors,records,generation,state)
      SELECT id,website_id,$2::uuid,0,repeat('a',64),snapshot->'rulepack'->>'hash','protected complete source',$3::uuid,1,1,'[]',$4::jsonb,$5::uuid,'finalized' FROM liekan_history_repair_run WHERE id=$1::uuid`,
        prepared.id,
        protectedUpload,
        actor.userId,
        JSON.stringify(records),
        protectedGeneration,
      );
      await execute(
        `INSERT INTO liekan_history_repair_input(run_id,website_id,upload_id,sequence,chunk_hash,rulepack_hash,source,actor_id,rows,accepted,errors,records,generation)
      SELECT r.id,r.website_id,$2::uuid,n,repeat('b',64),r.snapshot->'rulepack'->>'hash','unsubmitted source',$3::uuid,1,1,'[]','[]',r.generation FROM liekan_history_repair_run r CROSS JOIN generate_series(0,349) n WHERE r.id=$1::uuid`,
        prepared.id,
        unusedUpload,
        actor.userId,
      );
      await execute(
        `UPDATE liekan_history_repair_run SET status='paused',confirmed_at=NULL,updated_at=clock_timestamp()-interval '8 days',
      active_generation=CASE WHEN $4='active' THEN $2::uuid ELSE NULL END,
      previous_generation=CASE WHEN $4='previous' THEN $2::uuid ELSE NULL END,
      generation_archive=jsonb_build_object($2::text,jsonb_build_object('preview',jsonb_build_object('sourceUploads',jsonb_build_array($3::text)),'confirmedAt',clock_timestamp(),'archivedAt',clock_timestamp())) WHERE id=$1::uuid`,
        prepared.id,
        protectedGeneration,
        protectedUpload,
        pointer,
      );
      await reconcileHistoryRepairs();
      const [kept] = await q<{ state: string; records: typeof records }[]>(
        'SELECT state,records FROM liekan_history_repair_input WHERE run_id=$1::uuid AND upload_id=$2::uuid',
        prepared.id,
        protectedUpload,
      );
      expect(kept).toEqual({ state: 'finalized', records });
      const [remaining] = await q<{ open: number; discarded: number; total: number }[]>(
        `SELECT count(*) FILTER(WHERE state='open')::int AS open,count(*) FILTER(WHERE state='discarded')::int AS discarded,count(*)::int AS total FROM liekan_history_repair_input WHERE run_id=$1::uuid AND upload_id=$2::uuid`,
        prepared.id,
        unusedUpload,
      );
      expect(remaining).toEqual({ total: 250, open: 150, discarded: 100 });
      expect((await status()).status).toBe('expired');
      await execute(
        'DELETE FROM liekan_history_repair_input WHERE run_id=$1::uuid AND upload_id=$2::uuid',
        prepared.id,
        unusedUpload,
      );
    },
  );
  it('waits for an old batch and accepts its inherited NULL import before finalizing membership', async () => {
    const source = randomUUID(),
      batch = randomUUID();
    await execute(
      "INSERT INTO liekan_log_source(id,website_id,kind,domain,created_by,owner_id,state) VALUES($1::uuid,$2::uuid,'server','example.test',$3::uuid,$3::uuid,'active')",
      source,
      site,
      actor.userId,
    );
    await execute(
      "INSERT INTO liekan_ingest_batch(id,website_id,source_id,epoch,digest,payload,received,valid,rejected) VALUES($1::uuid,$2::uuid,$3::uuid,1,$4,'[]',0,0,0)",
      batch,
      site,
      source,
      'a'.repeat(64),
    );
    const run = await scan();
    await processHistoryRepairJob(run.id);
    expect((await status()).errorCode).toBe('waiting-old-batches');
    await execute(
      "INSERT INTO liekan_import(id,website_id,digest,accepted,rejected,kind,source_id) VALUES($1::uuid,$2::uuid,$3,0,0,'automatic',$4::uuid)",
      batch,
      site,
      'b'.repeat(64),
      source,
    );
    expect((await status()).scopeChanged).toBe(false);
    await execute("UPDATE liekan_ingest_batch SET state='processed' WHERE id=$1::uuid", batch);
    expect((await finish(run)).status).toBe('unidentifiable');
  });
  it('keeps a completed overlay and alerts on a restored excluded historical batch', async () => {
    const source = randomUUID(),
      batch = randomUUID();
    await execute(
      "INSERT INTO liekan_log_source(id,website_id,kind,domain,created_by,owner_id,state) VALUES($1::uuid,$2::uuid,'server','example.test',$3::uuid,$3::uuid,'active')",
      source,
      site,
      actor.userId,
    );
    await execute(
      "INSERT INTO liekan_ingest_batch(id,website_id,source_id,epoch,digest,payload,received,valid,rejected,state) VALUES($1::uuid,$2::uuid,$3::uuid,1,$4,'[]',0,0,0,'failed')",
      batch,
      site,
      source,
      'c'.repeat(64),
    );
    await log();
    const prepared = await finish(await scan());
    expect(prepared.preview.excludedBatches).toContain(batch);
    const active = await finish(
      await confirmHistoryRepair(
        site,
        {
          runId: prepared.id,
          actionId: randomUUID(),
          expectedRevision: prepared.revision,
          generation: prepared.generation,
          previewDigest: prepared.preview.digest,
          partialConfirmed: true,
        },
        actor,
      ),
    );
    await execute(
      "INSERT INTO liekan_import(id,website_id,digest,accepted,rejected,kind,source_id) VALUES($1::uuid,$2::uuid,$3,0,0,'automatic',$4::uuid)",
      batch,
      site,
      'd'.repeat(64),
      source,
    );
    const gap = await status();
    expect(gap.activeGeneration).toBe(active.generation);
    expect(gap.errorCode).toBe('active-scope-gap');
  });
  it('does not revive a cancelled queue step during reconciliation', async () => {
    const run = await scan();
    await execute(
      "UPDATE liekan_jobs.job SET state='cancelled' WHERE id=(SELECT queued_job_id FROM liekan_history_repair_run WHERE id=$1::uuid)",
      run.id,
    );
    await execute(
      "UPDATE liekan_history_repair_run SET updated_at=clock_timestamp()-interval '2 minutes' WHERE id=$1::uuid",
      run.id,
    );
    await reconcileHistoryRepairs();
    expect((await status()).status).toBe('failed');
    expect((await status()).errorCode).toBe('history-repair-queue-cancelled');
  });

  it('keeps old receiver writes nonblocking while a repair batch owns its task row', async () => {
    const run = await scan();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => {
        entered = resolve;
      }),
      gate = new Promise<void>(resolve => {
        release = resolve;
      });
    const holding = repairTransaction(async tx => {
      await tx.$queryRawUnsafe(
        'SELECT id FROM liekan_history_repair_run WHERE id=$1::uuid FOR NO KEY UPDATE',
        run.id,
      );
      entered();
      await gate;
    });
    await started;
    try {
      const began = Date.now();
      await event('2020-01-08');
      expect(Date.now() - began).toBeLessThan(900);
      expect((await status()).scopeChanged).toBe(true);
    } finally {
      release();
      await holding;
    }
    await processHistoryRepairJob(run.id);
    expect((await status()).status).toBe('invalidated');
  });
  it('fences an old queue claim when transfer and rescan replace its actor and generation after the first read', async () => {
    const original = await scan();
    const [oldQueue] = await q<{ queued_job_id: string }[]>(
      'SELECT queued_job_id::text FROM liekan_history_repair_run WHERE id=$1::uuid',
      original.id,
    );
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const holder = repairTransaction(async tx => {
      await tx.$queryRawUnsafe(
        'SELECT id FROM liekan_history_repair_campaign WHERE id=$1 FOR NO KEY UPDATE',
        HISTORY_REPAIR_CAMPAIGN,
      );
      entered();
      await gate;
    });
    await started;
    const stale = processHistoryRepairJob({ runId: original.id, stepId: oldQueue.queued_job_id });
    let current: HistoryRepairRun;
    let nextStep: string;
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const [activity] = await q<{ blocked: boolean }[]>(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query LIKE 'UPDATE liekan_history_repair_campaign SET lease_token=%' AND wait_event_type='Lock') AS blocked`,
        );
        if (activity.blocked) {
          blocked = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      await repairTransaction(async tx => {
        await tx.$executeRawUnsafe(
          'UPDATE website SET user_id=$2::uuid WHERE website_id=$1::uuid',
          site,
          other.userId,
        );
        await invalidateHistoryRepair(tx, site);
      });
      current = await scanHistoryRepair(site, { actionId: randomUUID(), timezone: 'UTC' }, other);
      nextStep = (
        await q<{ queued_job_id: string }[]>(
          'SELECT queued_job_id::text FROM liekan_history_repair_run WHERE id=$1::uuid',
          current.id,
        )
      )[0].queued_job_id;
      expect(current.id).toBe(original.id);
      expect(current.generation).not.toBe(original.generation);
      expect(nextStep).not.toBe(oldQueue.queued_job_id);
    } finally {
      release();
      await holder;
      await stale;
    }
    const [actual] = await q<
      {
        status: string;
        generation: string;
        actor_id: string;
        revision: number;
        queued_job_id: string;
        lease_token: string | null;
      }[]
    >(
      'SELECT status,generation::text,actor_id::text,revision,queued_job_id::text,lease_token::text FROM liekan_history_repair_run WHERE id=$1::uuid',
      current.id,
    );
    expect(actual).toMatchObject({
      status: 'scanning',
      generation: current.generation,
      actor_id: other.userId,
      revision: current.revision,
      queued_job_id: nextStep,
      lease_token: null,
    });
    const [campaign] = await q<{ lease_token: string | null }[]>(
      'SELECT lease_token::text FROM liekan_history_repair_campaign WHERE id=$1',
      HISTORY_REPAIR_CAMPAIGN,
    );
    expect(campaign.lease_token).toBeNull();
    expect(
      (
        await q<{ count: number }[]>(
          "SELECT count(*)::int AS count FROM liekan_history_repair_action WHERE run_id=$1::uuid AND action='worker-failure'",
          current.id,
        )
      )[0].count,
    ).toBe(0);
  });
  it('keeps incomplete and cancelled outcomes out of the completed notification', async () => {
    await execute(
      `INSERT INTO liekan_history_repair_notice(user_id,campaign_id,read_at) VALUES($1::uuid,$2,clock_timestamp()) ON CONFLICT(user_id,campaign_id) DO UPDATE SET read_at=clock_timestamp()`,
      actor.userId,
      HISTORY_REPAIR_CAMPAIGN,
    );
    await finish(await scan());
    expect((await listHistoryRepair(actor)).unreadCompletion).toBe(false);
  });
  it('yields to an exclusive website mutation without consuming a failure retry', async () => {
    const run = await scan();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const holding = repairTransaction(async tx => {
      await tx.$queryRawUnsafe(
        'SELECT website_id FROM website WHERE website_id=$1::uuid FOR UPDATE',
        site,
      );
      entered();
      await gate;
    });
    await started;
    try {
      await processHistoryRepairJob(run.id);
    } finally {
      release();
      await holding;
    }
    const [row] = await q<{ attempts: number; status: string; error_code: string }[]>(
      'SELECT attempts,status,error_code FROM liekan_history_repair_run WHERE id=$1::uuid',
      run.id,
    );
    expect(row.attempts).toBe(0);
    expect(row.status).toBe('scanning');
    expect(row.error_code).toBe('history-repair-collection-priority');
  });
  it('rejects a log cursor across activation and rollback even with the same original classification versions', async () => {
    const { getLogFacts } = await import('./logs');
    await log();
    const read = (cursor = '') =>
      getLogFacts(
        site,
        new Date('2019-01-01'),
        new Date('2021-01-01'),
        'UTC',
        1,
        '',
        '',
        cursor,
        'after',
        ['recent'],
        { crawlerMetricsVersion: 1, crawlerIdentityScope: 'all' },
      );
    const before = await read();
    expect(before.nextCursor).not.toBe('');
    const prepared = await finish(await scan());
    const active = await finish(
      await confirmHistoryRepair(
        site,
        {
          runId: prepared.id,
          actionId: randomUUID(),
          expectedRevision: prepared.revision,
          generation: prepared.generation,
          previewDigest: prepared.preview.digest,
          partialConfirmed: true,
        },
        actor,
      ),
    );
    await expect(read(before.nextCursor)).rejects.toMatchObject({ status: 409 });
    const current = await read();
    await actHistoryRepair(
      site,
      {
        runId: active.id,
        action: 'rollback',
        actionId: randomUUID(),
        expectedRevision: active.revision,
      },
      actor,
    );
    await expect(read(current.nextCursor)).rejects.toMatchObject({ status: 409 });
  });
  it('keeps bundled log aggregates equal to the canonical reporting view across activation and rollback', async () => {
    const { getLogFacts } = await import('./logs');
    const first = await log();
    await log('Mozilla/5.0');
    await execute(
      "UPDATE liekan_log SET bot='GPTBot',vendor='OpenAI',bot_type='训练',ai_eligible=true,recognition_state='recognized' WHERE website_id=$1::uuid AND id=$2",
      site,
      first,
    );
    const compare = async () => {
      const result = await getLogFacts(
        site,
        new Date('2019-01-01'),
        new Date('2021-01-01'),
        'UTC',
        1,
        '',
        '',
        '',
        'after',
        ['summary', 'daily', 'bots', 'pages', 'statuses', 'hours'],
        { crawlerMetricsVersion: 1, crawlerIdentityScope: 'all', resource: 'ai/overview' },
      );
      const [expected] = await q<any[]>(
        `SELECT count(*)::int AS requests,
        count(*) FILTER(WHERE coalesce(ai_eligible,bot_type IN('训练','搜索','用户触发')))::int AS ai,
        count(DISTINCT path) FILTER(WHERE coalesce(ai_eligible,bot_type IN('训练','搜索','用户触发')))::int AS pages
        FROM liekan_reporting_log WHERE website_id=$1::uuid
          AND created_at>='2019-01-01' AND created_at<'2021-01-01'
          AND user_agent NOT LIKE 'Liekan-Crawler-Check/%'`,
        site,
      );
      expect(result.summary).toMatchObject(expected);
      expect(result.summary.requests).toBe(2);
      expect(result.statuses.reduce((n, row) => n + row.count, 0)).toBe(expected.ai);
      expect(result.hours.reduce((n, row) => n + row.count, 0)).toBe(expected.ai);
      expect(new Set(result.pages.map(row => row.path)).size).toBe(expected.pages);
      expect(result.bots.length).toBeGreaterThan(0);
      expect(result.bots[0].lastVisit).toBeInstanceOf(Date);
      expect(result.pages[0].lastCrawled).toBeInstanceOf(Date);
    };
    await compare();
    const prepared = await finish(await scan());
    const active = await finish(
      await confirmHistoryRepair(
        site,
        {
          runId: prepared.id,
          actionId: randomUUID(),
          expectedRevision: prepared.revision,
          generation: prepared.generation,
          previewDigest: prepared.preview.digest,
          partialConfirmed: true,
        },
        actor,
      ),
    );
    await compare();
    await actHistoryRepair(
      site,
      {
        runId: active.id,
        action: 'rollback',
        actionId: randomUUID(),
        expectedRevision: active.revision,
      },
      actor,
    );
    await compare();
  });
  it('stops an approved candidate when the browser policy changes before activation', async () => {
    await log();
    const prepared = await finish(await scan());
    const queued = await confirmHistoryRepair(
      site,
      {
        runId: prepared.id,
        actionId: randomUUID(),
        expectedRevision: prepared.revision,
        generation: prepared.generation,
        previewDigest: prepared.preview.digest,
        partialConfirmed: true,
      },
      actor,
    );
    await execute(
      "INSERT INTO liekan_collection_policy(website_id,mode) VALUES($1::uuid,'raw')",
      site,
    );
    await processHistoryRepairJob(queued.id);
    const current = await status();
    expect(current.status).toBe('invalidated');
    expect(current.activeGeneration).toBeNull();
    expect(current.errorCode).toBe('history-repair-snapshot-changed');
  });
  it('expires obsolete unconfirmed generations after a newer generation succeeds', async () => {
    await log();
    const firstCandidate = await finish(await scan());
    const uploadA = randomUUID();
    const a = await ingestHistoryRepairEvidence(
      site,
      {
        runId: firstCandidate.id,
        action: 'append',
        actionId: randomUUID(),
        uploadId: uploadA,
        expectedRevision: firstCandidate.revision,
        sequence: 0,
        source: 'superseded source',
        records: [{ eventId: first, requestUserAgent: 'GPTBot/1.0' }],
      },
      actor,
    );
    const af = await ingestHistoryRepairEvidence(
      site,
      {
        runId: firstCandidate.id,
        action: 'finalize',
        actionId: randomUUID(),
        uploadId: uploadA,
        expectedRevision: a.revision,
        chunks: 1,
        rows: 1,
        manifest: [a.hash],
      },
      actor,
    );
    const secondCandidate = await finish(
      await previewHistoryRepair(
        site,
        { runId: firstCandidate.id, actionId: randomUUID(), expectedRevision: af.revision },
        actor,
      ),
    );
    const withdrawn = await ingestHistoryRepairEvidence(
      site,
      {
        runId: firstCandidate.id,
        action: 'discard',
        actionId: randomUUID(),
        uploadId: uploadA,
        expectedRevision: secondCandidate.revision,
      },
      actor,
    );
    const uploadB = randomUUID();
    const b = await ingestHistoryRepairEvidence(
      site,
      {
        runId: firstCandidate.id,
        action: 'append',
        actionId: randomUUID(),
        uploadId: uploadB,
        expectedRevision: withdrawn.revision,
        sequence: 0,
        source: 'approved source',
        records: [{ eventId: first, requestUserAgent: 'GPTBot/2.0' }],
      },
      actor,
    );
    const bf = await ingestHistoryRepairEvidence(
      site,
      {
        runId: firstCandidate.id,
        action: 'finalize',
        actionId: randomUUID(),
        uploadId: uploadB,
        expectedRevision: b.revision,
        chunks: 1,
        rows: 1,
        manifest: [b.hash],
      },
      actor,
    );
    const latest = await finish(
      await previewHistoryRepair(
        site,
        { runId: firstCandidate.id, actionId: randomUUID(), expectedRevision: bf.revision },
        actor,
      ),
    );
    const active = await finish(
      await confirmHistoryRepair(
        site,
        {
          runId: latest.id,
          actionId: randomUUID(),
          expectedRevision: latest.revision,
          generation: latest.generation,
          previewDigest: latest.preview.digest,
          partialConfirmed: true,
        },
        actor,
      ),
    );
    await execute(
      `UPDATE liekan_history_repair_run SET generation_archive=jsonb_set(jsonb_set(generation_archive,ARRAY[$2::text,'archivedAt'],to_jsonb((clock_timestamp()-interval '8 days')::text)),ARRAY[$3::text,'archivedAt'],to_jsonb((clock_timestamp()-interval '8 days')::text)) WHERE id=$1::uuid`,
      active.id,
      firstCandidate.generation,
      secondCandidate.generation,
    );
    await reconcileHistoryRepairs();
    const rows = await q<{ generation: string; count: string }[]>(
      'SELECT generation::text,count(*)::text FROM liekan_history_repair_result WHERE run_id=$1::uuid GROUP BY generation',
      active.id,
    );
    expect(rows.map(row => row.generation)).toEqual([active.generation]);
    const sources = await q<{ upload_id: string }[]>(
      'SELECT DISTINCT upload_id::text FROM liekan_history_repair_input WHERE run_id=$1::uuid',
      active.id,
    );
    expect(sources.map(source => source.upload_id)).toEqual([uploadB]);
    expect((await status()).activeGeneration).toBe(active.generation);
  });
  it('preserves previous sources across rulepack refresh and excludes their old summaries from the new candidate', async () => {
    await log();
    const prepared = await finish(await scan()),
      uploadId = randomUUID();
    const appended = await ingestHistoryRepairEvidence(
      site,
      {
        action: 'append',
        runId: prepared.id,
        actionId: randomUUID(),
        uploadId,
        expectedRevision: prepared.revision,
        sequence: 0,
        source: 'original approved source',
        records: [
          {
            eventId: first,
            requestUserAgent:
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          },
        ],
      },
      actor,
    );
    const finalized = await ingestHistoryRepairEvidence(
      site,
      {
        action: 'finalize',
        runId: prepared.id,
        actionId: randomUUID(),
        uploadId,
        expectedRevision: appended.revision,
        chunks: 1,
        rows: 1,
        manifestDigest: evidenceManifestDigest([appended.hash]),
      },
      actor,
    );
    await execute(
      `INSERT INTO liekan_history_repair_input(run_id,website_id,upload_id,sequence,chunk_hash,rulepack_hash,source,actor_id,rows,accepted,errors,records,generation,state)
      SELECT r.id,r.website_id,gen_random_uuid(),0,repeat('a',64),r.snapshot->'rulepack'->>'hash','approved archived file',$2::uuid,1,1,'[]','[]',r.generation,'finalized' FROM liekan_history_repair_run r CROSS JOIN generate_series(1,99) n WHERE r.id=$1::uuid`,
      prepared.id,
      actor.userId,
    );
    const approved = await finish(
      await previewHistoryRepair(
        site,
        { runId: prepared.id, actionId: randomUUID(), expectedRevision: finalized.revision },
        actor,
      ),
    );
    expect(approved.preview.sourceUploads).toHaveLength(100);
    expect(approved.preview.sourceUploads).toContain(uploadId);
    const active = await finish(
      await confirmHistoryRepair(
        site,
        {
          actionId: randomUUID(),
          runId: approved.id,
          expectedRevision: approved.revision,
          generation: approved.generation,
          previewDigest: approved.preview.digest,
          partialConfirmed: true,
        },
        actor,
      ),
    );
    await actHistoryRepair(
      site,
      {
        action: 'rollback',
        actionId: randomUUID(),
        runId: active.id,
        expectedRevision: active.revision,
      },
      actor,
    );
    await execute(
      `INSERT INTO liekan_setting(website_id,crawler_rules,rules_revision) VALUES($1::uuid,'{"mode":"official","disabledIds":[],"overrides":{},"customRules":[]}'::jsonb,1)
      ON CONFLICT(website_id) DO UPDATE SET rules_revision=liekan_setting.rules_revision+1`,
      site,
    );
    const fresh = await finish(await scan());
    expect(fresh.preview.rulepack.hash).not.toBe(approved.preview.rulepack.hash);
    expect(fresh.preview.sourceUploads).toEqual([]);
    expect(fresh.counts.browserEvidence).toBe('0');
    const [kept] = await q<{ state: string; count: number }[]>(
      'SELECT state,jsonb_array_length(records)::int AS count FROM liekan_history_repair_input WHERE run_id=$1::uuid AND upload_id=$2::uuid',
      fresh.id,
      uploadId,
    );
    expect(kept).toEqual({ state: 'finalized', count: 1 });
    expect((await getHistoryRepair(site, new URLSearchParams(), actor)).uploads).toEqual([]);
    const newUpload = randomUUID();
    const newAppend = await ingestHistoryRepairEvidence(
      site,
      {
        action: 'append',
        runId: fresh.id,
        actionId: randomUUID(),
        uploadId: newUpload,
        expectedRevision: fresh.revision,
        sequence: 0,
        source: 'new rulepack source',
        records: [{ eventId: first, requestUserAgent: 'GPTBot/1.0' }],
      },
      actor,
    );
    expect(newAppend.accepted).toBe(1);
    expect(newAppend.errors).toEqual([]);
    const newFinalized = await ingestHistoryRepairEvidence(
      site,
      {
        action: 'finalize',
        runId: fresh.id,
        actionId: randomUUID(),
        uploadId: newUpload,
        expectedRevision: newAppend.revision,
        chunks: 1,
        rows: 1,
        manifestDigest: evidenceManifestDigest([newAppend.hash]),
      },
      actor,
    );
    const next = await finish(
      await previewHistoryRepair(
        site,
        { actionId: randomUUID(), runId: fresh.id, expectedRevision: newFinalized.revision },
        actor,
      ),
    );
    expect(next.preview.sourceUploads).toEqual([newUpload]);
    const queued = await confirmHistoryRepair(
      site,
      {
        actionId: randomUUID(),
        runId: next.id,
        expectedRevision: next.revision,
        generation: next.generation,
        previewDigest: next.preview.digest,
        partialConfirmed: true,
      },
      actor,
    );
    expect(queued.status).toBe('queued');
    await finish(queued);
  });
  it('bounds persisted source errors while preserving cross-file conflict detection', async () => {
    const prepared = await finish(await scan());
    const invalid = randomUUID();
    const errorFile = await ingestHistoryRepairEvidence(
      site,
      {
        runId: prepared.id,
        action: 'append',
        actionId: randomUUID(),
        uploadId: invalid,
        expectedRevision: prepared.revision,
        sequence: 0,
        source: 'invalid IDs',
        records: Array.from({ length: 150 }, () => ({
          eventId: randomUUID(),
          requestUserAgent: 'GPTBot/1.0',
        })),
      },
      actor,
    );
    const detail = await getHistoryRepair(site, new URLSearchParams(), actor);
    expect(detail.uploads[0].errors).toHaveLength(100);
    expect(detail.uploads[0].moreErrors).toBe(true);
    expect(historyRepairDetailSchema.safeParse(detail).success).toBe(true);
    const dropped = await ingestHistoryRepairEvidence(
      site,
      {
        runId: prepared.id,
        action: 'discard',
        actionId: randomUUID(),
        uploadId: invalid,
        expectedRevision: errorFile.revision,
      },
      actor,
    );
    const firstFile = await ingestHistoryRepairEvidence(
      site,
      {
        runId: prepared.id,
        action: 'append',
        actionId: randomUUID(),
        uploadId: randomUUID(),
        expectedRevision: dropped.revision,
        sequence: 0,
        source: 'first precise source',
        records: [{ eventId: first, requestUserAgent: 'GPTBot/1.0' }],
      },
      actor,
    );
    const conflict = await ingestHistoryRepairEvidence(
      site,
      {
        runId: prepared.id,
        action: 'append',
        actionId: randomUUID(),
        uploadId: randomUUID(),
        expectedRevision: firstFile.revision,
        sequence: 0,
        source: 'conflicting source',
        records: [{ eventId: first, requestUserAgent: 'GPTBot/2.0' }],
      },
      actor,
    );
    expect(conflict.accepted).toBe(0);
    expect(conflict.errors).toEqual([{ row: 1, code: 'conflicting-event-evidence' }]);
  });
  it('keeps log identity and AI-page distinct counts separate from browser UV', async () => {
    await log('GPTBot/1.0');
    await log('GPTBot/1.0');
    await log('Googlebot/2.1');
    await proveFixtureIdentities();
    const prepared = await finish(await scan());
    expect(prepared.preview.logImpact.afterIdentities).toBe('2');
    expect(prepared.preview.logImpact.afterAiPages).toBe('1');
    expect(
      prepared.preview.logImpact.categories.find(row => row.category === 'all').afterRequests,
    ).toBe('3');
    expect(prepared.counts.beforeUV).toBe('1');
    expect(prepared.counts.afterUV).toBe('1');
  });
  it('activates a product-form-only correction using the exact catalog shown in the preview', async () => {
    const fixture = await productFormLogFixture();
    const { getLogFacts } = await import('./logs');
    const facts = (botProductForm: 'workbench' | 'personal_agent') =>
      getLogFacts(
        site,
        new Date('2019-01-01'),
        new Date('2021-01-01'),
        'UTC',
        1,
        '',
        '',
        '',
        'after',
        ['bots', 'pages', 'previousBots'],
        {
          crawlerMetricsVersion: 1,
          crawlerIdentityScope: 'all',
          resource: 'ai/pages',
          botProductForm,
        },
      );
    try {
      expect((await facts('workbench')).bots).toHaveLength(0);
      const prepared = await finish(await scan());
      expect(prepared.status).toBe('ready');
      expect(prepared.counts.changedEvents).toBe('0');
      expect(prepared.counts.changedLogs).toBe('1');
      expect(
        prepared.preview.logImpact.categories.find(item => item.category === 'workbench'),
      ).toMatchObject({ beforeRequests: '0', afterRequests: '1' });
      const confirmed = await confirmHistoryRepair(
        site,
        {
          actionId: randomUUID(),
          runId: prepared.id,
          expectedRevision: prepared.revision,
          generation: prepared.generation,
          previewDigest: prepared.preview.digest,
          partialConfirmed: true,
        },
        actor,
      );
      await finish(confirmed);
      const [reported] = await q<
        { form: string; catalog: string; verification: string; rawCatalog: string }[]
      >(
        `SELECT identity->>'productForm' AS form,l.reporting_catalog_version::text AS catalog,l.verification,e.catalog_version::text AS "rawCatalog" FROM liekan_reporting_log l JOIN liekan_crawler_evidence e ON e.website_id=l.website_id AND e.log_id=l.id JOIN liekan_crawler_registry_version v ON v.version=l.reporting_catalog_version CROSS JOIN LATERAL jsonb_array_elements(v.payload->'identities') identity WHERE l.website_id=$1::uuid AND l.id=$2 AND identity->>'id'=l.reporting_crawler_id`,
        site,
        fixture.id,
      );
      expect(reported).toEqual({
        form: 'workbench',
        catalog: fixture.currentVersion,
        verification: 'verified_range',
        rawCatalog: fixture.oldVersion,
      });
      const workbench = await facts('workbench');
      expect(workbench.bots).toHaveLength(1);
      expect(workbench.bots[0]).toMatchObject({
        name: 'GPTBot',
        productForm: 'workbench',
        requests: 1,
      });
      expect(workbench.pages).toHaveLength(1);
      expect(workbench.pages[0].lastCrawled).toBeInstanceOf(Date);
      expect(workbench.previousBots).toHaveLength(0);
      expect((await facts('personal_agent')).bots).toHaveLength(0);
    } finally {
      await fixture.restore();
    }
  });
  it('keeps disabled log classification on its original catalog in both preview and reporting', async () => {
    const fixture = await productFormLogFixture();
    try {
      await execute(
        'INSERT INTO liekan_setting(website_id,crawler_rules) VALUES($1::uuid,\'{"mode":"disabled"}\'::jsonb)',
        site,
      );
      await execute(
        "UPDATE liekan_event_quality SET reasons=ARRAY['browser_webdriver'] WHERE website_id=$1::uuid",
        site,
      );
      const prepared = await finish(await scan());
      expect(prepared.counts.changedEvents).toBe('1');
      expect(prepared.counts.changedLogs).toBe('0');
      expect(
        prepared.preview.logImpact.categories.find(item => item.category === 'workbench'),
      ).toMatchObject({ beforeRequests: '0', afterRequests: '0' });
      const confirmed = await confirmHistoryRepair(
        site,
        {
          actionId: randomUUID(),
          runId: prepared.id,
          expectedRevision: prepared.revision,
          generation: prepared.generation,
          previewDigest: prepared.preview.digest,
          partialConfirmed: true,
        },
        actor,
      );
      await finish(confirmed);
      const [reported] = await q<{ catalog: string; form: string }[]>(
        `SELECT l.reporting_catalog_version::text AS catalog,identity->>'productForm' AS form FROM liekan_reporting_log l JOIN liekan_crawler_registry_version v ON v.version=l.reporting_catalog_version CROSS JOIN LATERAL jsonb_array_elements(v.payload->'identities') identity WHERE l.website_id=$1::uuid AND l.id=$2 AND identity->>'id'=l.reporting_crawler_id`,
        site,
        fixture.id,
      );
      expect(reported).toEqual({ catalog: fixture.oldVersion, form: 'general' });
    } finally {
      await fixture.restore();
    }
  });
});
async function clearHistoryRepairInFixture() {
  await repairTransaction(tx => clearHistoryRepair(tx, site));
}
