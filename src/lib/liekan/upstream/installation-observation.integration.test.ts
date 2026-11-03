// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const enabled = process.env.LIEKAN_INSTALLATION_OBSERVATION_TEST === '1';
const owner = randomUUID(),
  website = randomUUID(),
  session = randomUUID();
const endAt = new Date('2026-10-27T09:30Z'),
  startAt = new Date(+endAt - 1800000);
let client: Client;
let api: typeof import('./installation-observation');
let prisma: typeof import('@/lib/prisma').default;
const evidence: Record<string, unknown> = {};

describe.skipIf(!enabled)('isolated PostgreSQL installation observation', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !url.pathname.startsWith('/installation_observation_')
    )
      throw new Error(
        'Installation observation integration requires its owned local test database',
      );
    client = new Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(`
      CREATE TABLE "user"(user_id uuid PRIMARY KEY,role text,deleted_at timestamptz);
      CREATE TABLE website(website_id uuid PRIMARY KEY,user_id uuid,team_id uuid,deleted_at timestamptz);
      CREATE TABLE team(team_id uuid PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE team_user(team_id uuid,user_id uuid,role text);
      CREATE TABLE liekan_setting(website_id uuid PRIMARY KEY,is_demo boolean);
      CREATE TABLE session(session_id uuid PRIMARY KEY,website_id uuid);
      CREATE TABLE website_event(event_id uuid PRIMARY KEY,website_id uuid,session_id uuid,event_type integer,created_at timestamptz);
      CREATE VIEW liekan_raw_website_event AS SELECT * FROM website_event;
      CREATE TABLE liekan_event_quality(event_id uuid PRIMARY KEY,website_id uuid,source text,created_at timestamptz);
      CREATE INDEX liekan_quality_observed ON liekan_event_quality(website_id,created_at,event_id);
      CREATE TABLE liekan_event_observation(event_id uuid PRIMARY KEY,website_id uuid,received_at timestamptz);
      CREATE INDEX liekan_observation_site_received ON liekan_event_observation(website_id,received_at);
      CREATE TABLE liekan_event_environment(event_id uuid PRIMARY KEY,website_id uuid,scope text,identity_available boolean,identity_version text);
    `);
    api = await import('./installation-observation');
    prisma = (await import('@/lib/prisma')).default;
  });
  afterAll(async () => {
    if (client && process.env.LIEKAN_INSTALLATION_OBSERVATION_OUTPUT) {
      evidence.postgresql = (await client.query('SHOW server_version')).rows[0].server_version;
      await writeFile(
        process.env.LIEKAN_INSTALLATION_OBSERVATION_OUTPUT,
        JSON.stringify(evidence, null, 2) + '\n',
        { mode: 0o600 },
      );
    }
    await prisma?.client.$disconnect();
    await client?.end();
  });
  beforeEach(async () => {
    await client.query(
      'TRUNCATE "user",website,team,team_user,liekan_setting,session,website_event,liekan_event_quality,liekan_event_observation,liekan_event_environment',
    );
    await client.query('INSERT INTO "user" VALUES($1,\'user\',NULL)', [owner]);
    await client.query('INSERT INTO website VALUES($1,$2,NULL,NULL)', [website, owner]);
    await client.query('INSERT INTO session VALUES($1,$2)', [session, website]);
  });
  async function event(
    options: {
      receipt?: Date;
      qualityAt?: Date;
      eventAt?: Date;
      available?: boolean;
      source?: string;
      environment?: boolean;
      quality?: boolean;
      missingSession?: boolean;
      type?: number;
    } = {},
  ) {
    const id = randomUUID();
    await client.query('INSERT INTO website_event VALUES($1,$2,$3,$4,$5)', [
      id,
      website,
      options.missingSession ? randomUUID() : session,
      options.type || 1,
      options.eventAt || new Date('2020-01-01T00:00Z'),
    ]);
    if (options.quality !== false)
      await client.query('INSERT INTO liekan_event_quality VALUES($1,$2,$3,$4)', [
        id,
        website,
        options.source || 'browser',
        options.qualityAt || startAt,
      ]);
    if (options.receipt)
      await client.query('INSERT INTO liekan_event_observation VALUES($1,$2,$3)', [
        id,
        website,
        options.receipt,
      ]);
    if (options.environment !== false)
      await client.query(
        "INSERT INTO liekan_event_environment VALUES($1,$2,$3,$4,'fixture-identity')",
        [
          id,
          website,
          options.source === 'legacy_override'
            ? 'legacy_override'
            : options.available === false
              ? 'browser_unresolved'
              : 'browser',
          options.source !== 'legacy_override' && options.available !== false,
        ],
      );
  }
  async function aggregate() {
    return (await client.query(api.installationObservationSql('public'), [website, startAt, endAt]))
      .rows[0];
  }
  it('matches the original raw public PV population, receipt fallback and half-open boundary', async () => {
    await event({ receipt: startAt, qualityAt: new Date(0) });
    await event({ receipt: new Date(+endAt - 1), available: false });
    await event({ environment: false });
    await event({ source: 'legacy_override' });
    await event({ receipt: endAt });
    await event({ receipt: new Date(+startAt - 1) });
    await event({ source: 'authenticated_server' });
    await event({ type: 2 });
    await event({ missingSession: true });
    await event({ quality: false, receipt: startAt });
    const actual = await aggregate();
    const [oracle] = (
      await client.query(
        `SELECT count(*)::float8 AS samples,
      count(*) FILTER(WHERE env.scope='browser' AND env.identity_available)::float8 AS available,
      count(*) FILTER(WHERE env.event_id IS NULL)::float8 AS unknown
      FROM liekan_raw_website_event e JOIN session s ON s.website_id=e.website_id AND s.session_id=e.session_id
      JOIN liekan_event_quality q ON q.website_id=e.website_id AND q.event_id=e.event_id
      LEFT JOIN liekan_event_observation o ON o.website_id=e.website_id AND o.event_id=e.event_id
      LEFT JOIN liekan_event_environment env ON env.website_id=e.website_id AND env.event_id=e.event_id
      WHERE e.website_id=$1 AND e.event_type=1 AND q.source IN('browser','legacy_override')
      AND coalesce(o.received_at,q.created_at)>=$2 AND coalesce(o.received_at,q.created_at)<$3`,
        [website, startAt, endAt],
      )
    ).rows;
    expect(actual).toMatchObject({ samples: 4, available: 1, unknown: 1, fallback: 2 });
    expect(actual).toMatchObject(oracle);
    const result = await api.readInstallationObservation(website, owner, +endAt);
    expect(result).toMatchObject({
      status: 'unknown',
      sampleCount: 4,
      availableIdentityCount: 1,
      unknownIdentityCount: 1,
      coverage: null,
    });
    expect(result.lastReceivedAt).toBe(new Date(+endAt - 1).toISOString());
  });
  it('keeps zero, unavailable and full samples distinct, and detects live authority changes', async () => {
    expect(await api.readInstallationObservation(website, owner, +endAt)).toMatchObject({
      status: 'empty',
      sampleCount: 0,
      coverage: null,
    });
    await event({ available: false });
    expect(await api.readInstallationObservation(website, owner, +endAt)).toMatchObject({
      status: 'unavailable',
      sampleCount: 1,
      coverage: 0,
      smallSample: true,
    });
    await client.query(
      "UPDATE liekan_event_environment SET scope='browser',identity_available=true",
    );
    expect(await api.readInstallationObservation(website, owner, +endAt)).toMatchObject({
      status: 'complete',
      sampleCount: 1,
      coverage: 1,
    });
    await client.query('UPDATE website SET user_id=$1', [randomUUID()]);
    await expect(api.readInstallationObservation(website, owner, +endAt)).rejects.toMatchObject({
      status: 403,
    });
  });
  it('enforces the independent deadline under a blocked receipt relation', async () => {
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE liekan_event_observation IN ACCESS EXCLUSIVE MODE');
    try {
      const started = performance.now();
      const result = await api.readInstallationObservation(website, owner, +endAt);
      const elapsed = performance.now() - started;
      expect(result).toMatchObject({
        status: 'temporarily_unavailable',
        sampleCount: null,
        coverage: null,
        reasons: ['diagnostic_timeout'],
      });
      expect(elapsed).toBeLessThan(2200);
      evidence.blockedMs = Math.round(elapsed);
      console.log(JSON.stringify({ installationObservationBlockedMs: Math.round(elapsed) }));
    } finally {
      await blocker.query('ROLLBACK');
      await blocker.end();
    }
  });
  it('keeps receipt-index work bounded when unrelated old history grows', async () => {
    for (let i = 0; i < 24; i++) await event({ receipt: startAt });
    const explain = async () =>
      (
        await client.query(
          'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + api.installationObservationSql('public'),
          [website, startAt, endAt],
        )
      ).rows[0]['QUERY PLAN'][0];
    await client.query('ANALYZE');
    const before = await explain();
    await client.query(
      `INSERT INTO website_event SELECT md5('old:'||i)::uuid,$1::uuid,$2::uuid,1,'2020-01-01'::timestamptz FROM generate_series(1,100000) i`,
      [website, session],
    );
    await client.query(
      "INSERT INTO liekan_event_quality SELECT md5('old:'||i)::uuid,$1::uuid,'browser','2020-01-01'::timestamptz FROM generate_series(1,100000) i",
      [website],
    );
    await client.query(
      "INSERT INTO liekan_event_observation SELECT md5('old:'||i)::uuid,$1::uuid,'2020-01-01'::timestamptz FROM generate_series(1,100000) i",
      [website],
    );
    await client.query('ANALYZE');
    const after = await explain();
    expect(await aggregate()).toMatchObject({ samples: 24, available: 24 });
    expect(after['Execution Time']).toBeLessThan(150);
    const nodes = (node: any): any[] => [node, ...(node.Plans || []).flatMap(nodes)];
    const indexes = nodes(after.Plan)
      .map(node => node['Index Name'])
      .filter(Boolean);
    expect(indexes).toContain('liekan_quality_observed');
    expect(indexes).toContain('liekan_observation_site_received');
    evidence.historyGrowth = { recentSamples: 24, unrelatedOldRows: 100000, before, after };
    console.log(
      JSON.stringify({
        installationObservationPlan: {
          beforeMs: before['Execution Time'],
          afterMs: after['Execution Time'],
          sharedHitBlocks: after.Plan['Shared Hit Blocks'],
          indexes,
        },
      }),
    );
  });
});
