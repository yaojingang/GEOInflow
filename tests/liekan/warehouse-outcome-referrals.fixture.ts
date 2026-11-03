import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { factTable, identifier } from '../../src/lib/liekan/warehouse/catalog';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';

/** Called only by the guarded warehouse-evidence synthetic-clone driver. */
export async function verifyOutcomeReferralAuthority({
  db,
  put,
  site,
  owner,
}: {
  db: ControlDatabase;
  put: (family: string, fields: Record<string, unknown>, postgres?: boolean) => Promise<unknown>;
  site: string;
  owner: string;
}) {
  const prefix = `/outcome-authority-${randomUUID()}`;
  const goalName = `outcome-${randomUUID()}`;
  const { crawlerReferralRows } = await import('../../src/lib/liekan/upstream/analytics');
  const { withTrafficPolicy } = await import('../../src/lib/liekan/upstream/traffic-query');
  const { streamOutcomeReferrals } = await import(
    '../../src/lib/liekan/upstream/warehouse-outcomes'
  );
  const start = new Date('2026-11-04T00:00:00Z'),
    end = new Date('2026-11-04T01:00:00Z');
  const pgOnly = async (family: string, fields: Record<string, unknown>) => {
    const row = factInput(family, fields),
      cols = factTable(family).columns;
    await db.transaction(tx =>
      tx.query(
        `INSERT INTO ${identifier(family)}(${cols.map(c => identifier(c.name)).join(',')}) VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        cols.map(c => row[c.name]),
      ),
    );
  };
  const write = async (
    kind: 'both' | 'ch' | 'pg',
    family: string,
    fields: Record<string, unknown>,
  ) => (kind === 'pg' ? pgOnly(family, fields) : put(family, fields, kind === 'both'));
  const event = async (
    kind: 'both' | 'ch' | 'pg',
    session: string,
    visit: string,
    time: string,
    path: string,
    custom = false,
  ) => {
    const eventId = randomUUID();
    await write(kind, 'website_event', {
      website_id: site,
      event_id: eventId,
      session_id: session,
      visit_id: visit,
      created_at: time,
      event_type: custom ? 2 : 1,
      url_path: path,
      event_name: custom ? goalName : null,
      referrer_domain: 'chatgpt.com',
      hostname: 'fixture.invalid',
    });
    await write(kind, 'liekan_event_quality', {
      website_id: site,
      event_id: eventId,
      classification: 'browser',
      source: 'browser',
      reasons: [],
      rule_version: 'fixture',
      range_status: 'missing',
      hostname: 'fixture.invalid',
      created_at: time,
    });
    await write(kind, 'liekan_event_environment', {
      website_id: site,
      event_id: eventId,
      scope: 'browser',
      identity_version: 'fixture',
      identity_available: true,
      browser: 'Chrome',
      origin_hostname: 'fixture.invalid',
      created_at: time,
    });
  };
  for (let n = 0; n < 2; n++)
    await db.transaction(tx =>
      tx.query(
        `INSERT INTO report(report_id,user_id,website_id,type,name,description,parameters)
     VALUES($1,$2,$3,'goal','Outcome overlap fixture','Synthetic only',$4)`,
        [randomUUID(), owner, site, JSON.stringify({ type: 'event', value: goalName })],
      ),
    );
  const sharedSession = randomUUID(),
    first = randomUUID(),
    second = randomUUID();
  await write('both', 'session', {
    website_id: site,
    session_id: sharedSession,
    created_at: '2026-11-03T23:50:00Z',
    browser: 'Chrome',
  });
  await event('both', sharedSession, first, '2026-11-03T23:50:00Z', `${prefix}/before`);
  await event('both', sharedSession, first, '2026-11-04T00:05:00Z', `${prefix}/later`);
  await event('both', sharedSession, first, '2026-11-04T00:06:00Z', `${prefix}/later`, true);
  await event('both', sharedSession, second, '2026-11-04T00:10:00Z', `${prefix}/second`);
  for (const kind of ['ch', 'pg'] as const) {
    const session = randomUUID(),
      visit = randomUUID();
    await write(kind, 'session', {
      website_id: site,
      session_id: session,
      created_at: '2026-11-04T00:15:00Z',
      browser: 'Chrome',
    });
    await event(kind, session, visit, '2026-11-04T00:15:00Z', `${prefix}/${kind}-only`);
  }
  const pgRows = await crawlerReferralRows(
    { query: (sql, ...args) => db.read(withTrafficPolicy(sql), args) },
    site,
    start,
    end,
    'UTC',
    { halfOpen: true, hostEvidence: true },
  );
  const chRows: any[] = [];
  await streamOutcomeReferrals(
    site,
    { startAt: +start, endAt: +end, timezone: 'UTC' } as any,
    async batch => {
      chRows.push(...batch.filter(row => String(row.path).startsWith(prefix)));
    },
  );
  const sharedPaths = new Set([`${prefix}/before`, `${prefix}/second`]);
  const normalized = (rows: any[]) =>
    rows.filter(row => sharedPaths.has(row.path)).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(normalized(chRows), normalized(pgRows));
  assert.equal(
    normalized(chRows).reduce((n, row) => n + row.visits, 0),
    2,
    'Two visits in one session must not become one UV',
  );
  const before = chRows.find(row => row.path === `${prefix}/before`);
  assert.equal(before?.visits, 1, 'Entry before the window must retain attribution');
  assert.equal(before?.conversions, 1);
  assert.equal(before?.goalEvents, 1, 'Two overlapping goal definitions must count the event once');
  assert.ok(
    chRows.some(row => row.path === `${prefix}/ch-only`),
    'CH-only accepted event must be present',
  );
  assert.ok(
    !chRows.some(row => row.path === `${prefix}/pg-only`),
    'PG-only fact must not leak into CH outcome',
  );
  assert.ok(pgRows.some(row => row.path === `${prefix}/pg-only`));
  assert.ok(!pgRows.some(row => row.path === `${prefix}/ch-only`));
}
