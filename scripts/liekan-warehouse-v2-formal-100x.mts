#!/usr/bin/env node
/** Formal HTTP read/write acceptance on a newly created warehouse Compose project. */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from '@clickhouse/client';
import pg from 'pg';
import { certify, logLane, visibility } from './liekan-warehouse-v2-visibility.ts';
import { benchmarkBrowserHeaders, benchmarkIpHeader } from './liekan-benchmark-fixtures.ts';
import {
  DAY,
  HISTORY,
  HOST,
  PREFLIGHT,
  lanePath,
  seedSite,
} from './liekan-warehouse-v2-formal-fixture.mts';

const BASE = process.env.BENCH_BASE_URL || 'http://127.0.0.1:3000';
const USER = process.env.BENCH_ADMIN_USER || 'admin';
const PG = new pg.Client({ connectionString: process.env.DATABASE_URL });
const CH = createClient({
  url: process.env.LIEKAN_CLICKHOUSE_URL,
  database: process.env.LIEKAN_CLICKHOUSE_DATABASE,
  username: process.env.LIEKAN_CLICKHOUSE_USERNAME,
  password: process.env.LIEKAN_CLICKHOUSE_PASSWORD,
  request_timeout: 180_000,
});
const BATCHES = PREFLIGHT ? 1 : 2178,
  BROWSER = PREFLIGHT ? 1 : 22,
  WINDOW = PREFLIGHT ? 1000 : 66_000,
  LANES = 20;
const NOW = () => performance.timeOrigin + performance.now();
const output = process.env.BENCH_OUTPUT_DIR || '/tmp/liekan-formal-' + randomUUID();
const paths = Array.from({ length: LANES }, (_, i) => lanePath(i));
type Fixture = Awaited<ReturnType<typeof seedSite>>;
type Http = { start: number; headers: number; end: number; status: number; data: any };
type Input = {
  seq: number;
  path: string;
  id: string;
  due: number;
  start: number;
  headers: number;
  end: number;
  status: number;
  responseId?: string;
  valid: boolean;
  processed?: number;
  seen?: number;
};
type Snap = {
  kind: 'week' | 'reconciliation' | 'browser';
  start: number;
  end: number;
  status: number;
  pv?: number;
  uv?: number;
  total?: number;
  lanes?: number[];
  browserPv?: number;
  shape?: boolean;
  scored: boolean;
};
type Fact = {
  id: string;
  path: string;
  count: number;
  unique: number;
  bytes: number[];
  ids: string[];
  pathCount: number;
  sourceHostRows: number;
};
let admin = '';
let anchor = 0;
const ms = (v: number) => Math.round(v * 100) / 100;
const pct = (xs: number[], p = 0.95) =>
  xs.length ? ms([...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1]) : null;

async function http(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Http> {
  const start = NOW();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    });
    const received = NOW(),
      text = await res.text(),
      end = NOW();
    let data: null | any = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* Invalid bodies fail shape checks. */
    }
    return { start, headers: received, end, status: res.status, data };
  } catch {
    const end = NOW();
    return { start, headers: end, end, status: 0, data: null };
  }
}

function clockString(t: number) {
  const d = new Date(t),
    date = d.toUTCString();
  return (
    date.slice(5, 7) +
    '/' +
    date.slice(8, 11) +
    '/' +
    d.getUTCFullYear() +
    ':' +
    date.slice(17, 25) +
    ' +0000'
  );
}

function statusCounts(inputs: { status: number }[]) {
  const counts: Record<string, number> = {};
  for (const v of inputs) counts[v.status] = (counts[v.status] || 0) + 1;
  return counts;
}

async function read(f: Fixture, kind: Snap['kind'], from: number, scored: boolean): Promise<Snap> {
  const endAt = Date.now() - 1;
  const startAt =
    kind === 'week' ? endAt - 7 * DAY : kind === 'reconciliation' ? endAt - DAY : from;
  const base = '/api/liekan/websites/' + f.site + '/traffic-quality/';
  const qs = new URLSearchParams({
    startAt: String(startAt),
    endAt: String(endAt),
    timezone: 'Asia/Shanghai',
    crawlerMetricsVersion: '1',
  });
  if (kind === 'reconciliation') {
    qs.set('sourceId', f.source);
    qs.set('hostname', HOST);
    qs.set('sort', 'path');
    qs.set('direction', 'asc');
  } else qs.set('subset', 'raw');
  const r = await http(
    'GET',
    base + (kind === 'reconciliation' ? 'reconciliation' : 'observations') + '?' + qs,
    admin,
  );
  const s: Snap = { kind, start: r.start, end: r.end, status: r.status, scored };
  if (r.status !== 200) return s;
  const d = r.data;
  if (kind === 'reconciliation') {
    s.total = d?.rawRequests;
    s.browserPv = d?.browserTotals?.pv;
    s.uv = d?.browserTotals?.uv;
    s.lanes = d?.rows?.map((x: any) => x.requests);
    s.shape =
      d?.state === 'available' &&
      d?.meta?.hostname === HOST &&
      d?.meta?.total === HISTORY.paths &&
      Array.isArray(d.rows) &&
      d.rows.length === LANES &&
      d.rows.every(
        (v: any, i: number) => v.humanPath === paths[i] && Number.isSafeInteger(v.requests),
      );
  } else {
    s.pv = d?.totals?.pv;
    s.uv = d?.totals?.uv;
    s.shape = Number.isSafeInteger(s.pv) && Number.isSafeInteger(s.uv);
  }
  return s;
}

async function chRows<T>(query: string, query_params: Record<string, unknown>): Promise<T[]> {
  return (await CH.query({ query, query_params, format: 'JSONEachRow' })).json<T>();
}

async function baseline(f: Fixture, from: number) {
  const [week, recon, browser] = await Promise.all([
    read(f, 'week', from, false),
    read(f, 'reconciliation', from, false),
    read(f, 'browser', from, false),
  ]);
  assert(week.shape && recon.shape && browser.shape, 'baseline route shape');
  assert.equal(week.pv, HISTORY.pv);
  assert.equal(week.uv, HISTORY.uv);
  assert.equal(recon.total, HISTORY.logs);
  assert.equal(recon.browserPv, 25900);
  assert.equal(recon.uv, 24000);
  assert.equal(browser.pv, 0);
  const [log] = await chRows<{ n: string; uniqueIds: string; hours: string; hosts: string }>(
    `SELECT count() n,uniqExact(id) uniqueIds,countIf(request_host={host:String} AND source_id={source:UUID}) hosts,
    uniqExact(intDiv(toUnixTimestamp64Milli(created_at)-{anchor:Int64}+86400000,3600000)) hours
    FROM ch_v2_logs WHERE website_id={site:UUID}`,
    { site: f.site, anchor, host: HOST, source: f.source },
  );
  assert.equal(+log.n, HISTORY.logs);
  assert.equal(+log.uniqueIds, HISTORY.logs);
  assert.equal(+log.hours, 24);
  assert.equal(+log.hosts, HISTORY.logs);
  const days = await chRows<{ day: string; n: string; uv: string; ids: string; hosts: string }>(
    `SELECT toString(toDate(received_at,'Asia/Shanghai')) AS day,
    count() n,uniqExact(event_id) ids,uniqExact(session_id) uv,countIf(hostname={host:String} AND is_eligible AND collection_source='browser') hosts FROM ch_v2_browser_events WHERE website_id={site:UUID} GROUP BY day ORDER BY day`,
    { site: f.site, host: HOST },
  );
  assert.equal(days.length, 7);
  assert(
    days.every(
      (v, i) =>
        v.day === new Date(anchor + 8 * 3600000 + (i - 6) * DAY).toISOString().slice(0, 10) &&
        +v.n === 25900 &&
        +v.ids === 25900 &&
        +v.uv === 24000 &&
        +v.hosts === 25900,
    ),
  );
  return { week, recon, browser, days, log };
}

function serverBatchId(source: string, id: string) {
  const data = createHash('sha256')
    .update(source + ':1:' + id)
    .digest()
    .subarray(0, 16);
  data[6] = (data[6] & 15) | 80;
  data[8] = (data[8] & 63) | 128;
  const hex = data.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

async function verifyFacts(
  f: Fixture,
  logs: Input[],
  browsers: Input[],
  generation: string,
  from: number,
) {
  const accepted = logs.filter(i => i.status === 200);
  const facts = await chRows<Fact>(
    `SELECT toString(import_id) id,any(src.path) path,uniqExact(src.path) pathCount,countIf(src.request_host={host:String} AND src.host_basis='configured_host' AND src.source_id={source:UUID}) sourceHostRows,count() count,uniqExact(id_) unique,groupArray(id_) ids,
    arraySort(groupArray(src.bytes)) bytes FROM
    (SELECT import_id,path,id id_,bytes,request_host,host_basis,source_id FROM ch_v2_logs WHERE website_id={site:UUID} AND import_id IS NOT NULL AND _deleted=0) AS src
    GROUP BY import_id`,
    { site: f.site, host: HOST, source: f.source },
  );
  const byFact = new Map(facts.map(v => [v.id, v]));
  const pgRows: Array<{
    id: string;
    status: string;
    state: string;
    processed: number;
    inserted: number;
    batch_inserted: number;
    valid: number;
    rejected: number;
    conflicts: number;
    processed_ms: string;
  }> = (
    await PG.query(
      `SELECT u.batch_id::text AS id,u.status,u.processed,u.inserted,u.conflicts,b.state,
    b.valid,b.rejected,b.inserted AS batch_inserted,extract(epoch FROM b.processed_at)*1000 AS processed_ms
    FROM liekan_warehouse_upload u LEFT JOIN liekan_ingest_batch b ON b.id=u.batch_id WHERE u.website_id=$1`,
      [f.site],
    )
  ).rows;
  const byReceipt = new Map(pgRows.map(v => [v.id, v]));
  assert.equal(facts.length, accepted.length, 'ClickHouse import set');
  assert.equal(pgRows.length, accepted.length, 'PG receipt set');
  for (const x of logs) {
    const id = serverBatchId(f.source, x.id),
      row = byReceipt.get(id),
      fact = byFact.get(id);
    if (x.status !== 200) {
      assert(!row && !fact, 'nonaccepted input left visible state');
      continue;
    }
    assert(x.valid && x.responseId === id, 'log HTTP receipt mismatch');
    assert(
      row?.status === 'processed' &&
        row?.state === 'processed' &&
        Number(row.processed) === 2 &&
        Number(row.inserted) === 2 &&
        Number(row.batch_inserted) === 2 &&
        Number(row.valid) === 2 &&
        Number(row.rejected) === 0 &&
        Number(row.conflicts) === 0,
      'PG processing mismatch',
    );
    const expected = [0, 1]
      .map(j =>
        createHmac('sha256', process.env.APP_SECRET!)
          .update(JSON.stringify([f.source, generation, x.seq * 2 + j]))
          .digest('hex'),
      )
      .sort();
    assert(
      fact && +fact.pathCount === 1 && fact.ids.sort().join() === expected.join(),
      'source event identities mismatch',
    );
    assert(
      fact?.path === x.path &&
        +fact.sourceHostRows === 2 &&
        +fact.count === 2 &&
        +fact.unique === 2 &&
        fact.bytes.map(Number).join(',') === '1024,2048',
      'CH two facts mismatch',
    );
    assert(row.processed_ms !== null);
    x.processed = Number(row.processed_ms);
    assert(Number.isFinite(x.processed));
  }
  const browserFacts = await chRows<{
    id: string;
    path: string;
    n: string;
    qualified: string;
    session: string;
  }>(
    `SELECT toString(client_event_id) id,toString(any(event_id)) serverEventId,any(url_path) path,count() n,
    countIf(hostname={host:String} AND normalized_hostname={host:String} AND origin_hostname={host:String}
    AND identity_scope='browser' AND identity_available AND is_eligible AND classification='browser' AND collection_source='browser') qualified,
    toString(any(session_id)) session FROM ch_v2_browser_events WHERE website_id={site:UUID} AND received_at>=fromUnixTimestamp64Milli({from:Int64}) AND _deleted=0 GROUP BY client_event_id`,
    { site: f.site, host: HOST, from },
  );
  const byEvent = new Map(browserFacts.map(v => [v.id, v]));
  assert.equal(
    browsers.filter(i => i.status === 200).length,
    browserFacts.length,
    'browser event set',
  );
  for (const x of browsers)
    if (x.status === 200) {
      const fact = byEvent.get(x.id);
      assert(
        x.valid &&
          fact?.path === x.path &&
          +fact.n === 1 &&
          +fact.qualified === 1 &&
          fact.session === x.responseId,
        'browser event identity mismatch',
      );
    } else assert(!byEvent.has(x.id), 'failed browser event persisted');
  return { facts, pgRows, browserFacts };
}

async function pgClock() {
  const samples: { offset: number; uncertainty: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const start = NOW(),
      db = Number(
        (await PG.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS t')).rows[0].t,
      ),
      end = NOW();
    samples.push({ offset: db - (end + start) / 2, uncertainty: (end - start) / 2 });
  }
  return samples.sort((a, b) => a.uncertainty - b.uncertainty)[0];
}

async function run(phase: 'pure' | 'mixed', f: Fixture) {
  const from = Date.now() - 1000;
  const initial = await baseline(f, from);
  const clockBefore = await pgClock();
  const generation = randomUUID(),
    logs: Input[] = [],
    browsers: Input[] = [],
    snaps: Snap[] = [];
  const issued = NOW() + 400,
    stopAt = issued + WINDOW;
  let lastAck = Infinity,
    allRequestsComplete = false;
  const pending: Promise<void>[] = [];
  async function sendLog(seq: number, due: number) {
    const id = randomUUID(),
      path = paths[logLane(seq)],
      stamp = clockString(Date.now()),
      body = {
        version: 1,
        batchId: id,
        epoch: 1,
        events: [0, 1].map(j => ({
          generation,
          offset: seq * 2 + j,
          line: `192.0.2.5 - - [${stamp}] "GET ${path} HTTP/1.1" 200 ${j ? 2048 : 1024} "-" "SyntheticValidation"`,
        })),
      };
    const r = await http('POST', '/api/liekan/log-sources/' + f.source + '/batches', f.token, body);
    logs.push({
      seq,
      path,
      id,
      due,
      start: r.start,
      headers: r.headers,
      end: r.end,
      status: r.status,
      responseId: r.data?.batchId,
      valid:
        r.data?.requestBatchId === id &&
        r.data?.received === 2 &&
        r.data?.valid === 2 &&
        r.data?.rejected === 0 &&
        r.data?.duplicate === false,
    });
  }
  async function sendBrowser(seq: number, due: number) {
    const id = randomUUID(),
      path = paths[seq % LANES];
    const r = await http(
      'POST',
      '/api/send',
      '',
      {
        type: 'event',
        payload: {
          website: f.site,
          eventId: id,
          hostname: HOST,
          url: path,
          screen: '1920x1080',
          language: 'zh-CN',
        },
      },
      {
        ...benchmarkBrowserHeaders,
        'accept-language': 'zh-CN,zh;q=0.9',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        origin: 'https://' + HOST,
        referer: 'https://' + HOST + '/',
      },
    );
    browsers.push({
      seq,
      path,
      id,
      due,
      start: r.start,
      headers: r.headers,
      end: r.end,
      status: r.status,
      responseId: r.data?.sessionId,
      valid: typeof r.data?.sessionId === 'string' && typeof r.data?.visitId === 'string',
    });
  }
  async function reader(kind: Snap['kind']) {
    await sleep(Math.max(0, issued - NOW()));
    for (;;) {
      const s = await read(f, kind, from, NOW() < stopAt);
      snaps.push(s);
      if (allRequestsComplete && s.start >= lastAck && s.shape) {
        const okLog = logs.filter(x => x.status === 200).length,
          okBrowser = browsers.filter(x => x.status === 200).length;
        if (
          kind === 'reconciliation' &&
          s.total === HISTORY.logs + okLog * 2 &&
          s.browserPv === 25900 + okBrowser
        )
          break;
        if (
          (kind === 'week' && s.pv === HISTORY.pv + okBrowser) ||
          (kind === 'browser' && s.pv === okBrowser)
        )
          break;
      }
      if (allRequestsComplete && NOW() > lastAck + 30_000) break;
      await sleep(kind === 'browser' ? 450 : 200);
    }
  }
  const readers =
    phase === 'mixed' ? (['week', 'reconciliation', 'browser'] as const).map(reader) : [];
  for (let seq = 0; seq < BATCHES; seq++) {
    const due = issued + (seq * WINDOW) / BATCHES;
    await sleep(Math.max(0, due - NOW()));
    pending.push(sendLog(seq, due));
    if (seq % 99 === 0) pending.push(sendBrowser(seq / 99, due));
  }
  await Promise.all(pending);
  lastAck = Math.max(...logs.map(x => x.end), ...browsers.map(x => x.end));
  allRequestsComplete = true;
  await Promise.all(readers);
  const clockAfter = await pgClock();
  const a = logs.filter(x => x.status === 200),
    b = browsers.filter(x => x.status === 200);
  const evidence = {
    phase,
    site: f.site,
    source: f.source,
    generation,
    clockBefore,
    clockAfter,
    issued,
    stopAt,
    initial,
    snaps,
    logs,
    browsers,
  };
  const record = (name: string, value: unknown) =>
    writeFile(join(output, phase + '-' + name + '.json'), JSON.stringify(value) + '\n', {
      mode: 0o600,
    });
  await record('trace', evidence);
  assert(
    a.length > 0 && b.length === BROWSER && logs.every(x => x.status === 200 || x.status === 429),
    'workload rejected: ' +
      JSON.stringify({ logs: statusCounts(logs), browsers: statusCounts(browsers) }),
  );
  const facts = await verifyFacts(f, logs, browsers, generation, from);
  await record('facts', facts);
  const final = await Promise.all([
    read(f, 'week', from, false),
    read(f, 'reconciliation', from, false),
    read(f, 'browser', from, false),
  ]);
  await record('final', final);
  assert(
    final.every(s => s.shape),
    'final response shapes',
  );
  const [w, r, canary] = final;
  const distinctSessions = new Set(facts.browserFacts.map(x => x.session)).size;
  assert.equal(w.pv, HISTORY.pv + b.length);
  assert.equal(w.uv, HISTORY.uv + distinctSessions);
  assert.equal(canary.pv, b.length);
  assert.equal(canary.uv, distinctSessions);
  assert.equal(r.total, HISTORY.logs + 2 * a.length);
  assert.equal(r.browserPv, 25900 + b.length);
  assert.equal(r.uv, 24000 + distinctSessions);
  for (let i = 0; i < LANES; i++)
    assert.equal(
      r.lanes![i],
      initial.recon.lanes![i] + 2 * a.filter(x => x.path === paths[i]).length,
    );
  assert(
    Math.abs(clockAfter.offset - clockBefore.offset) < 20 &&
      clockAfter.uncertainty < 10 &&
      clockBefore.uncertainty < 10,
    'PG clock calibration unreliable',
  );
  if (phase === 'mixed') {
    for (let i = 0; i < LANES; i++)
      certify(
        a.filter(x => x.path === paths[i]),
        snaps.filter(s => s.kind === 'reconciliation'),
        initial.recon.lanes![i],
        s => s.lanes?.[i],
        2,
      );
    certify(
      b,
      snaps.filter(s => s.kind === 'browser'),
      0,
      s => s.pv,
      1,
    );
  }
  const weekly = b.map(x => ({ ...x, seen: undefined }) as Input);
  if (phase === 'mixed')
    certify(
      weekly,
      snaps.filter(s => s.kind === 'week'),
      HISTORY.pv,
      s => s.pv,
      1,
    );
  await record('trace', {
    ...evidence,
    weekly,
    method:
      'Two uniquely identified CH facts per accepted PG receipt. All writes to each site are generated here. A business lane count equal to all eventually accepted inputs started by HTTP completion proves the entire closed cohort. Later nondecreasing snapshots preserve this evidence. Timings are conservative first proven HTTP observations.',
  });
  const pages = Object.fromEntries(
    (['week', 'reconciliation', 'browser'] as const).map(kind => {
      const rs = snaps.filter(s => s.scored && s.kind === kind);
      return [
        kind,
        {
          n: rs.length,
          status: statusCounts(rs),
          invalid: rs.filter(s => !s.shape).length,
          p95Ms: pct(rs.map(s => s.end - s.start)),
        },
      ];
    }),
  );
  const maxReceiptClockError =
    Math.max(clockBefore.uncertainty, clockAfter.uncertainty) +
    Math.abs(clockAfter.offset - clockBefore.offset);
  return {
    phase,
    attempts: logs.length,
    accepted: a.length,
    logHTTP: statusCounts(logs),
    browserHTTP: statusCounts(browsers),
    browserEvents: b.length,
    uniqueLogFacts: facts.facts.length * 2,
    expectedRowsPerAccepted: 2,
    pgReceipts: facts.pgRows.length,
    distinctBrowserSessions: distinctSessions,
    actualSendDelayP95Ms: pct(logs.map(x => x.start - x.due)),
    lastSendOffsetMs: ms(Math.max(...logs.map(x => x.start)) - issued),
    sendToResponseHeadersP95Ms: pct(a.map(x => x.headers - x.start)),
    sendToResponseBodyP95Ms: pct(a.map(x => x.end - x.start)),
    sendToPgProcessedP95Ms: pct(a.map(x => x.processed! - clockBefore.offset - x.start)),
    pgClockUncertaintyMs: ms(maxReceiptClockError),
    pages,
    logAckToReconciliation: phase === 'mixed' ? visibility(a) : null,
    browserAckToRecentObservation: phase === 'mixed' ? visibility(b) : null,
    browserAckToWeeklyObservation: phase === 'mixed' ? visibility(weekly) : null,
    finalTotals: { pv: w.pv, uv: w.uv, dayBrowserPv: r.browserPv, rawRequests: r.total },
    integrity: true,
  };
}

async function main() {
  assert(
    /^v2accept[a-z0-9_-]+$/.test(process.env.BENCH_COMPOSE_PROJECT || ''),
    'Use the new isolated Compose acceptance project',
  );
  assert(
    new URL(BASE).hostname === '127.0.0.1' &&
      new URL(process.env.DATABASE_URL!).hostname === 'db' &&
      new URL(process.env.LIEKAN_CLICKHOUSE_URL!).hostname === 'warehouse-ch' &&
      process.env.APP_SECRET,
    'Expected isolated Compose service identities',
  );
  await mkdir(output, { mode: 0o700, recursive: false });
  console.log('Acceptance evidence directory', output);
  await PG.connect();
  try {
    const login = await http('POST', '/api/auth/login', '', {
      username: USER,
      password: process.env.BENCH_ADMIN_PASS || 'liekan',
    });
    assert.equal(login.status, 200);
    assert(login.data?.token);
    admin = login.data.token;
    anchor = Date.now() - 2000;
    assert.equal(
      process.env.CLIENT_IP_HEADER,
      benchmarkIpHeader,
      'Configure only the isolated benchmark ingress',
    );
    if (PREFLIGHT) {
      const fixture = await seedSite(PG, CH, USER, 'preflight', anchor);
      const pilot = await run('mixed', fixture);
      assert(
        pilot.accepted === 1 &&
          pilot.browserEvents === 1 &&
          pilot.pgReceipts === 1 &&
          pilot.uniqueLogFacts === 2 &&
          pilot.distinctBrowserSessions === 1 &&
          [
            pilot.logAckToReconciliation,
            pilot.browserAckToWeeklyObservation,
            pilot.browserAckToRecentObservation,
          ].every(v => v?.matched === 1),
        'single-batch round-trip proof failed',
      );
      await writeFile(join(output, 'preflight.json'), JSON.stringify(pilot, null, 2));
      console.log('Single-batch identity, upload and page preflight passed');
      return;
    }
    const pureSite = await seedSite(PG, CH, USER, 'pure', anchor);
    const mixedSite = await seedSite(PG, CH, USER, 'mixed', anchor);
    const pure = await run('pure', pureSite);
    console.log(JSON.stringify(pure));
    await writeFile(join(output, 'pure.json'), JSON.stringify(pure, null, 2));
    await sleep(62_000);
    const mixed = await run('mixed', mixedSite);
    const delta =
      pure.sendToPgProcessedP95Ms && mixed.sendToPgProcessedP95Ms !== null
        ? ms(100 * (mixed.sendToPgProcessedP95Ms / pure.sendToPgProcessedP95Ms - 1))
        : null;
    const vis = mixed.logAckToReconciliation!;
    const obs = mixed.browserAckToWeeklyObservation!;
    const recent = mixed.browserAckToRecentObservation!;
    const validRun =
      [pure, mixed].every(
        r =>
          r.attempts === BATCHES &&
          r.accepted > 0 &&
          r.browserEvents === BROWSER &&
          Object.keys(r.logHTTP).every(k => k === '200' || k === '429'),
      ) && Object.values(mixed.pages).every(p => p.n > 0 && !p.invalid);
    const meetsFiveSeconds = (v: ReturnType<typeof visibility>) =>
      v.accepted > 0 && v.p95AckToPageMs !== null && v.p95AckToPageMs <= 5000;
    const gates = {
      logAckToReconciliationP95Within5s: meetsFiveSeconds(vis),
      browserAckToWeeklyObservationP95Within5s: meetsFiveSeconds(obs),
      browserAckToRecentObservationP95Within5s: meetsFiveSeconds(recent),
      mixedPgProcessingIncreaseWithin20Pct: delta !== null && delta <= 20,
    };
    const result = {
      pure,
      mixed,
      validRun,
      pgProcessedP95IncreasePct: delta,
      gates,
      pass: validRun && pure.integrity && mixed.integrity && Object.values(gates).every(Boolean),
    };
    await writeFile(join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
    if (!result.pass) process.exitCode = 2;
  } finally {
    await PG.end();
    await CH.close();
  }
}
main().catch(err => {
  console.error('Acceptance run failed:', err.message);
  process.exitCode = 1;
});
