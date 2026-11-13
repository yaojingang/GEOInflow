import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseReportQuery } from '../../src/lib/liekan/contracts/query';
import { buildReport } from '../../src/lib/liekan/report';
import { withPublishedRegistry } from '../../src/lib/liekan/upstream/crawler-registry-context';
import { withoutQueryCache } from '../../src/lib/liekan/upstream/cache-context';
import { prepareWarehousePageReport } from '../../src/lib/liekan/upstream/warehouse-page-report';
import { withinWarehouseReport } from '../../src/lib/liekan/upstream/warehouse-report-snapshot';
import { storedFact } from '../../src/lib/liekan/warehouse/candidate';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';

const normalized = (value: any) => JSON.parse(JSON.stringify(value));
export async function verifyWarehouseBrowserPages({ db, ch, site, run, put }: any) {
  assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
  assert.match(run, /^warehouse_contracts_\d+$/);
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  const [website] = await db.read(
    'SELECT website_id AS id,name,domain FROM website WHERE website_id=$1',
    [site],
  );
  const large = process.env.WAREHOUSE_BROWSER_PAGE_LARGE === '1';
  const resources = ['overview', 'content', 'human/sources'];
  const params = (resource: string, startAt: number, endAt: number, page = 1) => {
    const parsed = parseReportQuery({
      resource,
      startAt,
      endAt,
      timezone: 'UTC',
      tp_srcBody: page,
      tp_topBody: page,
      tp_visitorTopBody: page,
      tp_pgBody: page,
      tp_visitorPgBody: page,
    });
    assert.equal(parsed.success, true);
    if (!parsed.success) throw new Error('fixture-query');
    return parsed.data;
  };
  const compare = async (p: ReturnType<typeof params>, enabled: boolean, qualified: boolean) =>
    withoutQueryCache(() =>
      withPublishedRegistry(() =>
        withinWarehouseReport(async () => {
          const expected = await buildReport(website, false, p, true);
          const prepared = await prepareWarehousePageReport(website, p);
          try {
            const actual = await buildReport(website, false, p, true, false, undefined, prepared);
            assert.equal(
              actual.meta.aiCrawlerEnabled,
              enabled,
              'AI switch must be observed in this request',
            );
            assert.equal(
              actual.meta.population.identity.status,
              qualified ? 'complete' : 'unavailable',
              'Identity fixture must exercise its intended population',
            );
            assert.deepEqual(
              normalized(actual),
              normalized(expected),
              `${p.resource} page ${p.tablePages.srcBody} complete prepared parity`,
            );
          } finally {
            await prepared?.dispose?.();
          }
        }),
      ),
    );
  if (!large) {
    const prefix = randomUUID(),
      session = randomUUID();
    await put('session', {
      website_id: site,
      session_id: session,
      browser: 'Chrome',
      created_at: '2026-11-01T14:59:00Z',
    });
    for (const resolved of [true, false]) {
      const hour = resolved ? '15' : '16';
      for (let n = 0; n < 26; n++) {
        const id = randomUUID(),
          created = `2026-11-01T${hour}:00:${String(n).padStart(2, '0')}Z`;
        await put('website_event', {
          website_id: site,
          event_id: id,
          session_id: session,
          visit_id: randomUUID(),
          created_at: created,
          event_type: 1,
          url_path: `/browser-small-${prefix}/${String(n).padStart(2, '0')}`,
          hostname: 'fixture.invalid',
          referrer_domain:
            n === 24 ? 'chatgpt.com' : n === 25 ? null : `source${String(n).padStart(2, '0')}.test`,
          utm_campaign: n % 2 ? 'a' : 'b',
        });
        await put('liekan_event_quality', {
          website_id: site,
          event_id: id,
          classification: 'browser',
          source: 'browser',
          reasons: [],
          rule_version: 'fixture',
          range_status: 'missing',
          hostname: 'fixture.invalid',
          created_at: created,
        });
        await put('liekan_event_environment', {
          website_id: site,
          event_id: id,
          scope: resolved ? 'browser' : 'browser_unresolved',
          identity_version: 'fixture',
          identity_available: resolved,
          browser: 'Chrome',
          origin_hostname: 'fixture.invalid',
          created_at: created,
        });
      }
    }
    const [setting] = await db.read(
      'SELECT ai_crawler_enabled AS enabled FROM liekan_setting WHERE website_id=$1',
      [site],
    );
    try {
      for (const enabled of [true, false]) {
        await db.transaction((tx: any) =>
          tx.query(
            `INSERT INTO liekan_setting(website_id,ai_crawler_enabled) VALUES($1,$2)
          ON CONFLICT(website_id) DO UPDATE SET ai_crawler_enabled=EXCLUDED.ai_crawler_enabled,updated_at=now()`,
            [site, enabled],
          ),
        );
        for (const hour of ['15', '16'])
          for (const resource of resources)
            for (const page of [1, 2]) {
              const start = +new Date(`2026-11-01T${hour}:00:00Z`);
              await compare(params(resource, start, start + 59000, page), enabled, hour === '15');
            }
      }
    } finally {
      await db.transaction((tx: any) =>
        setting
          ? tx.query(
              'UPDATE liekan_setting SET ai_crawler_enabled=$2,updated_at=now() WHERE website_id=$1',
              [site, setting.enabled],
            )
          : tx.query('DELETE FROM liekan_setting WHERE website_id=$1', [site]),
      );
    }
    console.log(
      JSON.stringify({
        browserPreparedParity: 24,
        identity: ['qualified', 'missing'],
        ai: [true, false],
      }),
    );
    return;
  }

  // Reuse the previously verified keyword fixture's 100013 events and complete
  // session/quality/environment packages. Publish only a newer event candidate;
  // accepted older support facts remain the exact same IDs and epoch. Original
  // keyword CSV evidence applies to its former publication, not this changed one.
  const [state] = await db.read(
    'SELECT epoch::text,publication::text FROM liekan_warehouse_site WHERE website_id=$1',
    [site],
  );
  const baseParams = { site, epoch: state.epoch };
  const query = (sql: string, extra = {}) =>
    ch
      .query({ query: sql, query_params: { ...baseParams, ...extra }, format: 'JSONEachRow' })
      .then((r: any) => r.json());
  const [count] = await query(
    `SELECT count() AS count FROM warehouse_website_event WHERE website_id={site:UUID} AND _epoch={epoch:UInt64} AND _topic_id='fixture-keywords'`,
  );
  const total = Number(count.count);
  assert.equal(total, 100013, 'Run the isolated keyword large fixture first');
  const version = String(BigInt(state.publication) + 1n),
    attempt = randomUUID(),
    candidate = randomUUID();
  for (let offset = 0; offset < total; offset += 1000) {
    const rows = await query(
      `SELECT * FROM warehouse_website_event WHERE website_id={site:UUID} AND _epoch={epoch:UInt64} AND _topic_id='fixture-keywords'
      AND _ordinal>={offset:UInt64} AND _ordinal<{until:UInt64} ORDER BY _ordinal`,
      { offset, until: Math.min(total, offset + 1000) },
    );
    assert.equal(rows.length, Math.min(1000, total - offset));
    const values = rows.map((row: any) => {
      const n = Number(row._ordinal),
        suffix = String(n).padStart(6, '0');
      return storedFact(
        'website_event',
        factInput('website_event', {
          ...row,
          url_path: '/browser-page-large/' + suffix,
          utm_source: 'source-' + suffix,
        }),
        {
          _website_id: site,
          _record_time: '2026-11-01 13:00:00.000000',
          _session_id: row.session_id,
          _epoch: state.epoch,
          _version: version,
          _ordinal: n,
          _attempt_id: attempt,
          _candidate_id: candidate,
          _topic_id: 'fixture-browser-pages',
          _partition: 0,
          _offset: String(n),
          _deleted: false,
        },
      );
    });
    await ch.insert({ table: 'warehouse_website_event', format: 'JSONEachRow', values });
  }
  await ch.insert({
    table: 'warehouse_publication',
    format: 'JSONEachRow',
    values: [
      {
        website_id: site,
        epoch: state.epoch,
        publication: version,
        attempt_id: attempt,
        family: 'website_event',
        candidate_id: candidate,
        row_count: total,
        digest: 'a'.repeat(64),
        published_at: '2026-11-03 03:00:00.000000',
      },
    ],
  });
  await db.transaction((tx: any) =>
    tx.query('UPDATE liekan_warehouse_site SET publication=$2 WHERE website_id=$1', [
      site,
      version,
    ]),
  );
  const startAt = +new Date('2026-11-01T13:00:00Z');
  for (const resource of resources)
    for (const page of [1, 5001])
      await withoutQueryCache(() =>
        withPublishedRegistry(() =>
          withinWarehouseReport(async () => {
            const p = params(resource, startAt, startAt + 1000, page),
              prepared = await prepareWarehousePageReport(website, p);
            try {
              const report = await buildReport(website, false, p, true, false, undefined, prepared);
              const table =
                resource === 'overview' ? 'topBody' : resource === 'content' ? 'pgBody' : 'srcBody';
              assert.equal(report.meta.tablePages[table].total, total);
              assert.equal(report.tables[table].length, page === 1 ? 20 : 13);
              if (resource === 'content')
                assert.equal(report.cards.find(card => card.key === '有流量页面').value, total);
              if (resource === 'human/sources')
                assert.equal(report.cards.find(card => card.key === '直接访问').value, 0);
              assert.ok(Buffer.byteLength(JSON.stringify(report)) < 1000000);
            } finally {
              await prepared?.dispose?.();
            }
          }),
        ),
      );
  console.log(
    JSON.stringify({ browserPreparedLarge: total, version, resources, pages: [1, 5001] }),
  );
}
