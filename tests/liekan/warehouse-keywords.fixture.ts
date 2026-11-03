import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { keywordConditionsSchema, selectKeywords } from '../../src/lib/liekan/contracts/keywords';
import { parseReportQuery } from '../../src/lib/liekan/contracts/query';
import { bindCacheRequest, withoutQueryCache } from '../../src/lib/liekan/upstream/cache-context';
import { prepareFeatureExport } from '../../src/lib/liekan/upstream/feature-exports';
import { readKeywordFacts, readKeywordPage } from '../../src/lib/liekan/upstream/keywords';
import { downloadWarehouseExport } from '../../src/lib/liekan/upstream/warehouse-export-artifact';
import { withWarehouseKeywords } from '../../src/lib/liekan/upstream/warehouse-keywords';
import { storedFact } from '../../src/lib/liekan/warehouse/candidate';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';

/** Called only by the guarded synthetic evidence-clone driver; never the
 * downloaded production database. All bulk payloads and downloads are batched. */
export async function verifyWarehouseKeywords({ db, ch, site, owner, run, put }: any) {
  assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
  assert.match(run, /^warehouse_contracts_\d+$/);
  const website = { id: site, name: 'Isolated keyword fixture', domain: 'fixture.invalid' };
  const range = {
    startAt: +new Date('2026-11-01T12:00:00Z'),
    endAt: +new Date('2026-11-01T12:01:00Z'),
    timezone: 'UTC',
  };
  const goal = `keyword-${randomUUID()}`;
  await db.transaction((tx: any) =>
    tx.query(
      `INSERT INTO report(report_id,user_id,website_id,type,name,description,parameters)
    VALUES($1,$2,$3,'goal','Keyword fixture','Synthetic only',$4)`,
      [randomUUID(), owner, site, JSON.stringify({ type: 'event', value: goal })],
    ),
  );
  const session = randomUUID();
  await put('session', {
    website_id: site,
    session_id: session,
    created_at: '2026-11-01T12:00:00Z',
    browser: 'Chrome',
  });
  const inputs = [
    { referrer_query: '?q=word' },
    { referrer_query: '?q=%77ord' },
    { referrer_query: '?q=person%40example.test' },
    { referrer_query: '?q=%E6' },
    { referrer_query: '', referrer_domain: 'www.baidu.com', referrer_path: '/link' },
    { referrer_query: '', referrer_domain: 'www.baidu.com', referrer_path: '/unsupported' },
    { referrer_query: '', referrer_domain: 'www.baidu.com', referrer_path: '/s' },
    { referrer_query: '', utm_term: 'literal%2B+' },
    { referrer_query: '', utm_term: 'token=secret' },
  ];
  for (let i = 0; i < inputs.length; i++) {
    const visit = randomUUID();
    for (const custom of i % 2 ? [false] : [false, true]) {
      const event = randomUUID(),
        created = `2026-11-01T12:00:${String(i * 2 + Number(custom)).padStart(2, '0')}Z`;
      await put('website_event', {
        website_id: site,
        event_id: event,
        session_id: session,
        visit_id: visit,
        created_at: created,
        event_type: custom ? 2 : 1,
        event_name: custom ? goal : null,
        url_path: '/keyword-fixture',
        hostname: 'fixture.invalid',
        referrer_domain: 'www.google.com',
        referrer_path: '/search',
        ...inputs[i],
      });
      await put('liekan_event_quality', {
        website_id: site,
        event_id: event,
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
        event_id: event,
        scope: 'browser',
        identity_version: 'fixture',
        identity_available: true,
        browser: 'Chrome',
        origin_hostname: 'fixture.invalid',
        created_at: created,
      });
    }
  }
  process.env.LIEKAN_ANALYTICS_BACKEND = 'postgresql';
  const expected = await withoutQueryCache(() => readKeywordFacts(site, range));
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  for (const modern of [false, true]) {
    const parameters = { ...range, keywordStatusVersion: modern ? '2' : undefined };
    await withWarehouseKeywords(site, parameters, async actual => {
      const rows: any[] = [];
      await actual.rows.stream(async batch => {
        rows.push(...batch);
      }); // Nine intentionally small source groups only.
      const selected = selectKeywords(
        expected.rows,
        keywordConditionsSchema.parse({}),
        expected.hasGoals,
        modern,
      );
      assert.deepEqual(rows, selected.rows);
      assert.equal(actual.snapshot, expected.snapshot);
      assert.equal(actual.total, selected.total);
      assert.equal(actual.referrer, selected.referrer);
      assert.equal(actual.utm, selected.utm);
      assert.ok(!JSON.stringify(rows).includes('person'));
      assert.ok(!JSON.stringify(rows).includes('secret'));
    });
  }

  const total = 100013,
    start = '2026-11-01T13:00:00Z',
    sessionId = randomUUID();
  const [state] = await db.read(
    'SELECT epoch::text,publication::text FROM liekan_warehouse_site WHERE website_id=$1',
    [site],
  );
  const version = String(BigInt(state.publication) + 1n),
    idPrefix = randomUUID().slice(0, 24);
  const term = (n: number) => '词'.repeat(220) + String(n).padStart(6, '0');
  const publications = [];
  for (const family of [
    'session',
    'website_event',
    'liekan_event_quality',
    'liekan_event_environment',
  ]) {
    const attempt = randomUUID(),
      candidate = randomUUID(),
      count = family === 'session' ? 1 : total;
    for (let offset = 0; offset < count; offset += 1000) {
      const values = Array.from({ length: Math.min(1000, count - offset) }, (_, index) => {
        const n = offset + index,
          event = idPrefix + n.toString(16).padStart(12, '0');
        const fields =
          family === 'session'
            ? { website_id: site, session_id: sessionId, created_at: start, browser: 'Chrome' }
            : family === 'website_event'
              ? {
                  website_id: site,
                  event_id: event,
                  session_id: sessionId,
                  visit_id: event,
                  created_at: start,
                  event_type: 1,
                  url_path: '/keyword-large-fixture',
                  hostname: 'fixture.invalid',
                  referrer_domain: 'www.google.com',
                  referrer_path: '/search',
                  referrer_query: '?q=' + term(n),
                }
              : family === 'liekan_event_quality'
                ? {
                    website_id: site,
                    event_id: event,
                    classification: 'browser',
                    source: 'browser',
                    reasons: [],
                    rule_version: 'fixture',
                    range_status: 'missing',
                    hostname: 'fixture.invalid',
                    created_at: start,
                  }
                : {
                    website_id: site,
                    event_id: event,
                    scope: 'browser',
                    identity_version: 'fixture',
                    identity_available: true,
                    browser: 'Chrome',
                    origin_hostname: 'fixture.invalid',
                    created_at: start,
                  };
        return storedFact(family, factInput(family, fields), {
          _website_id: site,
          _record_time: '2026-11-01 13:00:00.000000',
          _session_id: sessionId,
          _epoch: state.epoch,
          _version: version,
          _ordinal: n,
          _attempt_id: attempt,
          _candidate_id: candidate,
          _topic_id: 'fixture-keywords',
          _partition: 0,
          _offset: String(n),
          _deleted: false,
        });
      });
      await ch.insert({ table: 'warehouse_' + family, format: 'JSONEachRow', values });
    }
    publications.push({
      website_id: site,
      epoch: state.epoch,
      publication: version,
      attempt_id: attempt,
      family,
      candidate_id: candidate,
      row_count: count,
      digest: 'a'.repeat(64),
      published_at: '2026-11-03 03:00:00.000000',
    });
  }
  await ch.insert({ table: 'warehouse_publication', format: 'JSONEachRow', values: publications });
  await db.transaction((tx: any) =>
    tx.query('UPDATE liekan_warehouse_site SET publication=$2 WHERE website_id=$1', [
      site,
      version,
    ]),
  );
  const parameters = {
    startAt: +new Date(start),
    endAt: +new Date(start) + 1000,
    timezone: 'UTC',
    resource: 'human/keywords',
    keywordStatusVersion: '2',
    sort: 'keyword',
    direction: 'asc',
  };
  const page = async (extra = {}) =>
    withoutQueryCache(() =>
      readKeywordPage(website, parseReportQuery({ ...parameters, ...extra }).data!, 0, true),
    ).then(result => result.value);
  const first = await page();
  assert.equal(first.tables.keywordBody.length, 20);
  assert.equal(first.tables.keywordBody[0].keyword, term(0));
  assert.equal(first.meta.tablePages.keywordBody.total, total);
  assert.equal(first.cards[0].value, total);
  const last = await page({ page: 5001, keywordSnapshot: first.meta.keywordSnapshot });
  assert.equal(last.meta.keywordReset, false);
  assert.equal(last.tables.keywordBody.length, 13);
  assert.equal(last.tables.keywordBody.at(-1).keyword, term(total - 1));
  await withoutQueryCache(async () => {
    const request = new Request('http://localhost/api/exports', {
      method: 'POST',
      headers: { authorization: 'Bearer isolated-keyword-fixture' },
    });
    bindCacheRequest(request, { user: { id: owner, role: 'admin' } }, undefined, async () => true);
    const signal = new AbortController().signal;
    const response = await prepareFeatureExport(
      website,
      { ...parameters, kind: 'source-keywords', format: 'csv', locale: 'en-US' },
      signal,
    );
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.equal(frames.at(-1).type, 'complete', JSON.stringify(frames.at(-1)));
    const file = frames.find(frame => frame.type === 'file');
    assert.equal(file.manifest.rows, total);
    assert.ok(file.size > 50 * 1024 * 1024);
    const download = await downloadWarehouseExport(
      site,
      owner,
      file.downloadUrl.split('/').at(-1),
      signal,
    );
    let bytes = 0,
      rows = 0,
      largestChunk = 0,
      tail = '';
    const decoder = new StringDecoder('utf8');
    for await (const chunk of download.body as any) {
      bytes += chunk.length;
      largestChunk = Math.max(largestChunk, chunk.length);
      const lines = (tail + decoder.write(Buffer.from(chunk))).split('\r\n');
      tail = lines.pop()!;
      for (const line of lines)
        if (line.startsWith('词')) {
          assert.ok(line.startsWith(term(rows) + ','));
          rows++;
        }
    }
    assert.equal(decoder.end(), '');
    assert.equal(rows, total);
    assert.equal(bytes, file.size);
    assert.ok(largestChunk < 2 * 1024 * 1024);
    console.log(
      JSON.stringify({ keywordRows: rows, bytes, largestChunk, finalKeyword: String(total - 1) }),
    );
  });
}
