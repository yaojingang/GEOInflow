import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';
import Papa from 'papaparse';
import type pg from 'pg';
import { withinQuerySnapshot } from '../../src/lib/liekan/upstream/query-snapshot';
import { withoutQueryCache } from '../../src/lib/liekan/upstream/cache-context';
import { getSessionMetrics } from '../../src/queries/sql/sessions/getSessionMetrics';
import { getSessionExpandedMetrics } from '../../src/queries/sql/sessions/getSessionExpandedMetrics';
import { getPageviewMetrics } from '../../src/queries/sql/pageviews/getPageviewMetrics';
import { getPageviewExpandedMetrics } from '../../src/queries/sql/pageviews/getPageviewExpandedMetrics';
import { getEventMetrics } from '../../src/queries/sql/events/getEventMetrics';
import { getEventExpandedMetrics } from '../../src/queries/sql/events/getEventExpandedMetrics';
import { getPerformanceMetrics } from '../../src/queries/sql/performance/getPerformanceMetrics';
import { getBreakdown } from '../../src/queries/sql/breakdown/getBreakdown';
import { getValues } from '../../src/queries/sql/getValues';
import { getSessionReplays } from '../../src/queries/sql/replays/getSessionReplays';
import { getHeatmap } from '../../src/queries/sql/heatmap/getHeatmap';
import { featureAnalytics, featureJourney } from '../../src/lib/liekan/upstream/feature-analytics';
import { prepareFeatureExport } from '../../src/lib/liekan/upstream/feature-exports';

/** Environment groups, drilldowns and exports use the selected events' snapshots.
 * A later event in the same cookieless session must preserve old-window dimensions,
 * and historical events without environment proof remain outside qualified metrics.
 */
export async function verifyEventEnvironmentReads(db: pg.Client) {
  const site = randomUUID(),
    session = randomUUID(),
    visit = randomUUID();
  const executor = {
    $queryRawUnsafe: async (sql: string, ...params: any[]) => (await db.query(sql, params)).rows,
    $executeRawUnsafe: async (sql: string, ...params: any[]) =>
      (await db.query(sql, params)).rowCount,
  };
  const read = <T>(load: () => Promise<T>) => withinQuerySnapshot({ ...executor }, load);
  const filters = {
    startDate: new Date('2020-01-02Z'),
    endDate: new Date('2020-01-02T23:59:59Z'),
    timezone: 'UTC',
  };
  const featureRange = { startAt: +filters.startDate, endAt: +filters.endDate, timezone: 'UTC' };
  await db.query(
    "INSERT INTO website(website_id,name,domain) VALUES($1,'Environment regression','example.test')",
    [site],
  );
  await db.query(
    "INSERT INTO session(session_id,website_id,browser,created_at) VALUES($1,$2,'Unproven profile','2020-01-01Z')",
    [session, site],
  );
  const oldIds: string[] = [];
  for (const [at, path, environment] of [
    ['2020-01-02T01:00:00Z', '/one', ['Firefox', 'Linux', 'desktop', '1920x1080', 'en-US']],
    ['2020-01-02T01:01:00Z', '/two', ['Firefox', 'Linux', 'desktop', '1920x1080', 'en-US']],
    ['2020-01-02T01:02:00Z', '/custom', ['Firefox', 'Linux', 'desktop', '1920x1080', 'en-US']],
    ['2020-01-02T01:03:00Z', '/performance', ['Firefox', 'Linux', 'desktop', '1920x1080', 'en-US']],
    ['2020-01-03T01:00:00Z', '/later', ['Chrome', 'Windows', 'laptop', '1280x720', 'zh-CN']],
  ] as const) {
    const event = randomUUID();
    if (path !== '/later') oldIds.push(event);
    await db.query(
      "INSERT INTO website_event(event_id,website_id,session_id,visit_id,event_type,url_path,hostname,created_at) VALUES($1,$2,$3,$4,1,$5,'example.test',$6)",
      [event, site, session, visit, path, at],
    );
    if (path === '/custom' || path === '/performance')
      await db.query(
        "UPDATE website_event SET event_type=$2,event_name='custom',lcp=100 WHERE event_id=$1",
        [event, path === '/custom' ? 2 : 5],
      );
    await db.query(
      "INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status,hostname,created_at) VALUES($1,$2,'browser','browser','{}','traffic-quality-v4','missing','example.test',$3)",
      [event, site, at],
    );
    await db.query(
      "INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available,browser,os,device,screen,language) VALUES($1,$2,'browser','environment-fixture',true,$3,$4,$5,$6,$7)",
      [event, site, ...environment],
    );
  }
  for (const [type, expected] of Object.entries({
    browser: 'Firefox',
    os: 'Linux',
    device: 'desktop',
    screen: '1920x1080',
    language: 'en-US',
  })) {
    for (const query of [
      getSessionMetrics,
      getSessionExpandedMetrics,
      getPageviewMetrics,
      getPageviewExpandedMetrics,
    ]) {
      const rows = await read(() => query(site, { type }, filters));
      const label = 'name' in rows[0] ? rows[0].name : rows[0].x;
      const sessionLanguage =
        type === 'language' &&
        [getSessionMetrics, getSessionExpandedMetrics].includes(query as any);
      assert.equal(
        label,
        sessionLanguage ? 'en' : expected,
        `${query.name}/${type} uses the selected event environment`,
      );
    }
    if (type !== 'screen') {
      const values = await read(() => getValues(site, type, filters));
      assert.deepEqual(
        values.map(row => row.value),
        [expected],
        `${type} candidates include returning sessions and preserve the selected window`,
      );
    }
  }
  assert.equal(
    (await read(() => getEventMetrics(site, { type: 'device' }, filters)))[0].x,
    'desktop',
  );
  assert.equal(
    (await read(() => getEventExpandedMetrics(site, { type: 'device' }, filters)))[0].name,
    'desktop',
  );
  assert.equal(
    (
      await read(() =>
        getPerformanceMetrics(site, { ...filters, unit: 'day', metric: 'lcp' }, filters, 'device'),
      )
    )[0].name,
    'desktop',
  );
  assert.equal(
    (
      await read(() => getBreakdown(site, { ...filters, fields: ['browser', 'device'] }, filters))
    )[0].device,
    'desktop',
  );
  assert.equal(
    (
      await read(() =>
        getPageviewMetrics(site, { type: 'device' }, { ...filters, device: 'eq.desktop' }),
      )
    )[0].x,
    'desktop',
  );
  assert.deepEqual(
    await read(() =>
      getPageviewMetrics(site, { type: 'device' }, { ...filters, device: 'eq.laptop' }),
    ),
    [],
  );
  await db.query(
    "INSERT INTO session_replay(replay_id,website_id,session_id,visit_id,chunk_index,events,event_count,started_at,ended_at,created_at) VALUES($1,$2,$3,$4,0,$5,1,'2020-01-02T01:00Z','2020-01-02T01:01Z','2020-01-02T01:01Z')",
    [randomUUID(), site, session, visit, gzipSync('[]')],
  );
  for (const kind of ['sessions', 'replays']) {
    const result = await read(() => featureAnalytics(site, { ...featureRange, kind }));
    assert.equal(result.rows[0].browser, 'Firefox', `feature ${kind} browser`);
    assert.equal(result.rows[0].device, 'desktop', `feature ${kind} device`);
  }
  const journey = await read(() =>
    featureJourney(site, { ...featureRange, steps: 2, sequence: JSON.stringify(['/one', '/two']) }),
  );
  assert.equal(journey.sessions[0].browser, 'Firefox');
  assert.equal(journey.sessions[0].device, 'desktop');
  const replays = await read(() => getSessionReplays(site, filters));
  assert.equal(replays.data[0].browser, 'Firefox');
  assert.equal(replays.data[0].device, 'desktop');
  assert.equal(
    (await read(() => getSessionReplays(site, { ...filters, search: 'Firefox' }))).data.length,
    1,
  );
  assert.equal(
    (await read(() => getSessionReplays(site, { ...filters, search: 'Chrome' }))).data.length,
    0,
  );
  const replayFiltered = await read(() =>
    getSessionReplays(site, {
      ...filters,
      endDate: new Date('2020-01-03T23:59:59Z'),
      device: 'eq.desktop',
    }),
  );
  assert.equal(replayFiltered.data[0].device, 'desktop');
  const exportRows = async () => {
    const response = await prepareFeatureExport(
      { id: site, name: 'Environment regression', domain: 'example.test' },
      { ...featureRange, format: 'zip', sections: ['dimensions', 'sessions'] },
      new AbortController().signal,
    );
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map(row => JSON.parse(row));
    assert.equal(frames.at(-1).type, 'complete');
    const zip = await JSZip.loadAsync(
      Buffer.concat(
        frames
          .filter(frame => frame.type === 'chunk')
          .map(frame => Buffer.from(frame.data, 'base64')),
      ),
    );
    return async (name: string) =>
      Papa.parse(await zip.file(name).async('string'), { header: true }).data;
  };
  const exported = await exportRows();
  assert.equal((await exported('browsers.csv'))[0].name, 'Firefox');
  assert.equal((await exported('devices.csv'))[0].name, 'desktop');
  assert.equal((await exported('sessions.csv'))[0].browser, 'Firefox');
  for (const at of ['2020-01-02T01:00Z', '2020-01-03T01:00Z'])
    await db.query(
      `INSERT INTO heatmap_event(heatmap_event_id,website_id,session_id,visit_id,created_at,url_path,event_type,x,y,page_x,page_y,page_w,page_h,viewport_w,viewport_h)
      VALUES(gen_random_uuid(),$1,$2,$3,$4,'/one',1,10,20,10,20,1000,2000,1000,800)`,
      [site, session, visit, at],
    );
  const heatmap = await read(() =>
    getHeatmap(site, { ...filters, urlPath: '/one', device: 'eq.desktop' }),
  );
  assert.equal(heatmap.points.length, 1);
  assert.equal(heatmap.pages[0].sessions, 1);
  const unmatchedHeatmap = await read(() =>
    getHeatmap(site, { ...filters, urlPath: '/one', device: 'eq.mobile' }),
  );
  assert.deepEqual(unmatchedHeatmap.pages, []);
  assert.deepEqual(unmatchedHeatmap.points, []);
  const laterJourney = {
    ...featureRange,
    type: 'all',
    steps: 2,
    startStep: '/two',
    endStep: 'custom',
  };
  const noSource = await read(() => withoutQueryCache(() => featureJourney(site, laterJourney)));
  assert.equal(noSource.rows[0].source, null);
  await db.query(
    "UPDATE website_event SET referrer_domain=CASE WHEN url_path='/one' THEN 'google.com' ELSE 'baidu.com' END WHERE website_id=$1",
    [site],
  );
  const entrySource = await read(() =>
    withoutQueryCache(() => featureJourney(site, laterJourney)),
  );
  assert.equal(entrySource.rows[0].source, 'google.com');
  await db.query('UPDATE website_event SET referrer_domain=NULL WHERE website_id=$1', [site]);
  await db.query(
    `INSERT INTO revenue(revenue_id,website_id,session_id,event_id,event_name,currency,revenue,created_at)
    VALUES(gen_random_uuid(),$1,$2,$3,'custom','CNY',123.45,'2020-01-02T01:02Z')`,
    [site, session, oldIds[2]],
  );
  const revenue = await read(() =>
    featureAnalytics(site, { ...featureRange, kind: 'revenue', currency: 'CNY' }),
  );
  assert.equal(Number(revenue.count), 1);
  assert.equal(revenue.rows.length, 1);
  assert.equal(Number(revenue.rows[0].amount), 123.45);
  const unmatchedRevenue = await read(() =>
    featureAnalytics(site, {
      ...featureRange,
      kind: 'revenue',
      currency: 'CNY',
      drill_path: 'eq./not-collected',
    }),
  );
  assert.equal(Number(unmatchedRevenue.count), 0);
  assert.deepEqual(unmatchedRevenue.rows, []);
  await db.query(
    `INSERT INTO session_data(session_data_id,website_id,session_id,data_key,string_value,data_type)
    VALUES(gen_random_uuid(),$1,$2,'plan','team',1),(gen_random_uuid(),$1,$2,'unproven','hidden',1)`,
    [site, session],
  );
  await db.query(
    `INSERT INTO liekan_session_data_source(website_id,session_id,data_key,scope,hostname,classification,row_digest)
    SELECT website_id,session_id,data_key,'browser','example.test','browser',liekan_session_data_digest(d)
    FROM session_data d WHERE website_id=$1 AND data_key='plan'`,
    [site],
  );
  const properties = await read(() =>
    featureAnalytics(site, { ...featureRange, kind: 'session-properties' }),
  );
  assert.deepEqual(
    properties.rows.map(row => ({ ...row, sessions: Number(row.sessions) })),
    [{ name: 'plan', value: 'team', dataType: 1, sessions: 1 }],
  );
  const unmatchedProperties = await read(() =>
    featureAnalytics(site, {
      ...featureRange,
      kind: 'session-properties',
      drill_path: 'eq./not-collected',
    }),
  );
  assert.deepEqual(unmatchedProperties.rows, []);
  await db.query('DELETE FROM liekan_event_environment WHERE event_id=ANY($1::uuid[])', [oldIds]);
  assert.deepEqual(await read(() => getSessionMetrics(site, { type: 'browser' }, filters)), []);
  const unknown = await read(() => getValues(site, 'browser', filters));
  assert.equal(unknown.length, 0);
  const unknownExport = await exportRows();
  assert.equal((await unknownExport('browsers.csv')).some(row => Number(row.views) > 0), false);
  // Link and pixel event environments retain their compatible session dimensions.
  for (const type of [3, 4]) {
    const resource = randomUUID(),
      legacySession = randomUUID();
    await db.query(
      type === 3
        ? "INSERT INTO link(link_id,name,url,slug) VALUES($1,'Link','https://example.test/',$2)"
        : "INSERT INTO pixel(pixel_id,name,slug) VALUES($1,'Pixel',$2)",
      [resource, randomUUID()],
    );
    await db.query(
      "INSERT INTO session(session_id,website_id,browser,created_at) VALUES($1,$2,'Compatible browser','2020-01-02Z')",
      [legacySession, resource],
    );
    await db.query(
      "INSERT INTO website_event(event_id,website_id,session_id,visit_id,event_type,url_path,created_at) VALUES($1,$2,$3,$4,$5,'/','2020-01-02T01:00Z')",
      [randomUUID(), resource, legacySession, randomUUID(), type],
    );
    assert.equal(
      (await read(() => getSessionMetrics(resource, { type: 'browser' }, filters)))[0].x,
      'Compatible browser',
    );
  }
}
